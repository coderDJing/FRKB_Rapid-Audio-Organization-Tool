import { clipboard, ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs = require('fs-extra')
import path = require('path')
import { pathToFileURL } from 'url'
import { log } from '../log'

type ClipboardOperation = 'copy' | 'cut'

interface ClipboardWriteFilesPayload {
  filePaths?: string[]
  operation?: ClipboardOperation
}

const DROP_EFFECT_COPY = 1
const DROP_EFFECT_MOVE = 2
const execFileAsync = promisify(execFile)

const logClipboard = (level: 'debug' | 'warn' | 'error', message: string, payload?: unknown) => {
  const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'
  try {
    ;(log as any)[level](message, payload)
  } catch {}
  try {
    if (payload === undefined) {
      ;(console as any)[consoleMethod](message)
    } else {
      ;(console as any)[consoleMethod](message, payload)
    }
  } catch {}
}

const normalizePaths = (raw: unknown): string[] => {
  const list = Array.isArray(raw) ? raw : []
  const unique = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    unique.add(path.normalize(trimmed))
  }
  return Array.from(unique)
}

const filterExistingPaths = (paths: string[]): string[] => {
  return paths.filter((p) => {
    try {
      return fs.pathExistsSync(p)
    } catch {
      return false
    }
  })
}

const escapeXml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const buildMacFilenamesPlist = (paths: string[]): Buffer => {
  const items = paths.map((p) => `<string>${escapeXml(p)}</string>`).join('')
  const plist =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ` +
    `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">` +
    `<plist version="1.0"><array>${items}</array></plist>`
  return Buffer.from(plist, 'utf8')
}

const escapePowerShellString = (value: string) => {
  return value.replace(/'/g, "''")
}

const buildWindowsClipboardScript = (paths: string[], operation: ClipboardOperation) => {
  const listLines = paths
    .map((p) => `$files.Add('${escapePowerShellString(p)}') | Out-Null`)
    .join('\n')
  const dropEffect = operation === 'cut' ? DROP_EFFECT_MOVE : DROP_EFFECT_COPY
  return `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
$files = New-Object System.Collections.Specialized.StringCollection
${listLines}
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($files)
$ms = New-Object System.IO.MemoryStream
$bytes = [System.BitConverter]::GetBytes(${dropEffect})
$ms.Write($bytes, 0, $bytes.Length)
$ms.Position = 0
$data.SetData("Preferred DropEffect", $ms)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
$check = [System.Windows.Forms.Clipboard]::GetFileDropList()
"frkb_count=$($check.Count)"
if ($check.Count -gt 0) { "frkb_sample=$($check[0])" }
`
}

const writeWindowsFileClipboardViaPowerShell = async (
  paths: string[],
  operation: ClipboardOperation
) => {
  const script = buildWindowsClipboardScript(paths, operation)
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const result = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15000 }
    )
    const outputLines = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const countLine = outputLines.find((line) => line.startsWith('frkb_count='))
    const sampleLine = outputLines.find((line) => line.startsWith('frkb_sample='))
    const count = countLine ? Number(countLine.slice('frkb_count='.length)) : 0
    const sample = sampleLine ? sampleLine.slice('frkb_sample='.length) : ''
    logClipboard('debug', '[clipboard] powershell output', {
      count,
      sample,
      lines: outputLines
    })
    return {
      ok: Number.isFinite(count) && count > 0,
      count,
      sample
    }
  } catch (error) {
    logClipboard('warn', '[clipboard] powershell fallback failed', error)
    return { ok: false, count: 0, sample: '' }
  }
}

const canReadClipboardBuffer = (format: string) => {
  try {
    const buf = clipboard.readBuffer(format)
    return Buffer.isBuffer(buf) && buf.length > 0
  } catch {
    return false
  }
}

const writeMacFileClipboard = (paths: string[]) => {
  const fileUrls = paths.map((p) => pathToFileURL(p).toString()).join('\n')
  clipboard.clear()
  clipboard.writeBuffer('NSFilenamesPboardType', buildMacFilenamesPlist(paths))
  if (canReadClipboardBuffer('NSFilenamesPboardType')) return true
  clipboard.writeBuffer('public.file-url', Buffer.from(fileUrls, 'utf8'))
  return canReadClipboardBuffer('public.file-url')
}

export function registerClipboardHandlers() {
  ipcMain.handle('clipboard:write-files', async (_e, payload: ClipboardWriteFilesPayload) => {
    const operation: ClipboardOperation = payload?.operation === 'cut' ? 'cut' : 'copy'
    const normalizedPaths = normalizePaths(payload?.filePaths)
    const existingPaths = filterExistingPaths(normalizedPaths)
    logClipboard('debug', '[clipboard] write-files request', {
      operation,
      rawCount: Array.isArray(payload?.filePaths) ? payload?.filePaths?.length : 0,
      normalizedCount: normalizedPaths.length,
      existingCount: existingPaths.length,
      sample: existingPaths[0] || ''
    })
    if (existingPaths.length === 0) {
      return { success: false, existingPaths: [] }
    }
    try {
      if (process.platform === 'win32') {
        const psResult = await writeWindowsFileClipboardViaPowerShell(existingPaths, operation)
        if (!psResult.ok) {
          logClipboard('warn', '[clipboard] powershell write failed', {
            existingCount: existingPaths.length
          })
          return { success: false, existingPaths }
        }
        logClipboard('debug', '[clipboard] powershell write ok', {
          existingCount: existingPaths.length,
          sample: psResult.sample
        })
      } else if (process.platform === 'darwin') {
        const ok = writeMacFileClipboard(existingPaths)
        const formats = clipboard.availableFormats()
        logClipboard('debug', '[clipboard] mac formats', { ok, formats })
        if (!ok) return { success: false, existingPaths }
      } else {
        return { success: false, existingPaths }
      }
      return { success: true, existingPaths }
    } catch (error) {
      logClipboard('error', '[clipboard] write failed', error)
      return { success: false, existingPaths, error: String(error) }
    }
  })

  ipcMain.handle('paths:exists', async (_e, payload: string[] | { paths?: string[] }) => {
    const rawPaths = Array.isArray(payload) ? payload : payload?.paths
    const normalized = normalizePaths(rawPaths)
    const existingPaths = filterExistingPaths(normalized)
    return { existingPaths }
  })
}
