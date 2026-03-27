import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path = require('path')
import fs = require('fs-extra')
import { log } from '../../log'
import type { PioneerDeviceLibraryProbe, PioneerRemovableDriveInfo } from './types'

const execFileAsync = promisify(execFile)

type BaseDriveRow = {
  id: string
  name: string
  path: string
  volumeName: string
  fileSystem: string
  size: number
  freeSpace: number
  driveType: number | null
  driveTypeLabel: string
  isUsb: boolean
  isRemovable: boolean
}

const WINDOWS_DRIVE_TYPE_LABELS: Record<number, string> = {
  0: 'unknown',
  1: 'no-root-dir',
  2: 'removable',
  3: 'fixed',
  4: 'network',
  5: 'cdrom',
  6: 'ramdisk'
}

const normalizeDriveRoot = (value: string) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (process.platform === 'win32') {
    const match = raw.match(/^[A-Za-z]:/)
    if (match) {
      const drive = match[0].toUpperCase()
      return `${drive}/`
    }
  }
  const resolved = path.resolve(raw)
  return resolved.replace(/\\/g, '/')
}

const toSafeInt = (value: unknown) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.round(parsed)
}

export const probePioneerDeviceLibraryRoot = async (
  rootPath: string
): Promise<PioneerDeviceLibraryProbe> => {
  const normalizedRoot = normalizeDriveRoot(rootPath)
  if (!normalizedRoot) {
    return {
      hasPioneerFolder: false,
      hasRekordboxFolder: false,
      hasExportPdb: false,
      hasUsbAnlzFolder: false,
      pioneerFolderPath: null,
      rekordboxFolderPath: null,
      exportPdbPath: null,
      usbAnlzPath: null
    }
  }

  const pioneerFolderPath = path.join(normalizedRoot, 'PIONEER')
  const rekordboxFolderPath = path.join(pioneerFolderPath, 'rekordbox')
  const exportPdbPath = path.join(rekordboxFolderPath, 'export.pdb')
  const usbAnlzPath = path.join(pioneerFolderPath, 'USBANLZ')

  const [hasPioneerFolder, hasRekordboxFolder, hasExportPdb, hasUsbAnlzFolder] = await Promise.all([
    fs.pathExists(pioneerFolderPath),
    fs.pathExists(rekordboxFolderPath),
    fs.pathExists(exportPdbPath),
    fs.pathExists(usbAnlzPath)
  ])

  return {
    hasPioneerFolder,
    hasRekordboxFolder,
    hasExportPdb,
    hasUsbAnlzFolder,
    pioneerFolderPath: hasPioneerFolder ? pioneerFolderPath : null,
    rekordboxFolderPath: hasRekordboxFolder ? rekordboxFolderPath : null,
    exportPdbPath: hasExportPdb ? exportPdbPath : null,
    usbAnlzPath: hasUsbAnlzFolder ? usbAnlzPath : null
  }
}

const normalizeJsonArray = <T>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') return [value as T]
  return []
}

const convertPlistToJson = async (input: string): Promise<any> => {
  return await new Promise((resolve, reject) => {
    const child = spawn('plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `plutil exited with code ${code}`))
        return
      }
      try {
        resolve(JSON.parse(stdout || 'null'))
      } catch (error) {
        reject(error)
      }
    })

    child.stdin.write(input)
    child.stdin.end()
  })
}

const runMacPlistCommand = async (command: string, args: string[]) => {
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 1024 * 1024 * 8
  })
  return await convertPlistToJson(String(stdout || ''))
}

async function listWindowsRemovableDrives(): Promise<BaseDriveRow[]> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$usbLetters = New-Object 'System.Collections.Generic.HashSet[string]'",
    'Get-CimInstance Win32_DiskDrive | Where-Object {',
    "  $_.InterfaceType -eq 'USB' -or ($_.PNPDeviceID -like 'USBSTOR*')",
    '} | ForEach-Object {',
    '  $disk = $_',
    '  Get-CimAssociatedInstance -InputObject $disk -Association Win32_DiskDriveToDiskPartition -ErrorAction SilentlyContinue | ForEach-Object {',
    '    $partition = $_',
    '    Get-CimAssociatedInstance -InputObject $partition -Association Win32_LogicalDiskToPartition -ErrorAction SilentlyContinue | ForEach-Object {',
    '      $id = [string]$_.DeviceID',
    '      if ($id) { [void]$usbLetters.Add($id.ToUpperInvariant()) }',
    '    }',
    '  }',
    '}',
    '$rows = @()',
    'Get-CimInstance Win32_LogicalDisk | ForEach-Object {',
    '  $id = [string]$_.DeviceID',
    '  if (-not $id) { return }',
    '  $driveType = [int]$_.DriveType',
    '  $isUsb = $usbLetters.Contains($id.ToUpperInvariant())',
    '  $isRemovable = ($driveType -eq 2) -or $isUsb',
    '  if (-not $isRemovable) { return }',
    '  $rows += [PSCustomObject]@{',
    '    deviceId = $id',
    '    volumeName = [string]$_.VolumeName',
    '    driveType = $driveType',
    '    fileSystem = [string]$_.FileSystem',
    '    size = if ($_.Size) { [int64]$_.Size } else { 0 }',
    '    freeSpace = if ($_.FreeSpace) { [int64]$_.FreeSpace } else { 0 }',
    '    isUsb = $isUsb',
    '  }',
    '}',
    "if ($rows.Count -eq 0) { '[]' } else { $rows | ConvertTo-Json -Compress -Depth 4 }"
  ].join('\n')

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 8
      }
    )
    const rows = normalizeJsonArray<any>(JSON.parse(String(stdout || '[]')))
    const normalizedRows: BaseDriveRow[] = []
    for (const row of rows) {
      const deviceId = String(row?.deviceId || '')
        .trim()
        .toUpperCase()
      const rootPath = normalizeDriveRoot(deviceId)
      if (!deviceId || !rootPath) continue
      const driveType = Number.isFinite(Number(row?.driveType)) ? Number(row.driveType) : null
      const volumeName = String(row?.volumeName || '').trim()
      normalizedRows.push({
        id: deviceId,
        name: volumeName || deviceId,
        path: rootPath,
        volumeName,
        fileSystem: String(row?.fileSystem || '').trim(),
        size: toSafeInt(row?.size),
        freeSpace: toSafeInt(row?.freeSpace),
        driveType,
        driveTypeLabel:
          driveType !== null ? WINDOWS_DRIVE_TYPE_LABELS[driveType] || 'unknown' : 'unknown',
        isUsb: Boolean(row?.isUsb),
        isRemovable: true
      })
    }
    return normalizedRows.sort((left, right) =>
      left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })
    )
  } catch (error) {
    log.error('[pioneer-device-library] windows removable drive detection failed', error)
    return []
  }
}

async function listLinuxRemovableDrives(): Promise<BaseDriveRow[]> {
  try {
    const { stdout } = await execFileAsync(
      'lsblk',
      ['-J', '-b', '-o', 'NAME,RM,HOTPLUG,TRAN,MOUNTPOINT,LABEL,FSTYPE,SIZE'],
      {
        maxBuffer: 1024 * 1024 * 8
      }
    )
    const parsed = JSON.parse(String(stdout || '{}')) as {
      blockdevices?: Array<Record<string, any>>
    }

    const rows: BaseDriveRow[] = []
    const walk = (item: Record<string, any>) => {
      const mountpoint = typeof item?.mountpoint === 'string' ? item.mountpoint.trim() : ''
      const rm = Number(item?.rm) === 1
      const hotplug = Number(item?.hotplug) === 1
      const transport = String(item?.tran || '')
        .trim()
        .toLowerCase()
      const isUsb = transport === 'usb'
      if (mountpoint && (rm || hotplug || isUsb)) {
        const rootPath = normalizeDriveRoot(mountpoint)
        rows.push({
          id: String(item?.name || rootPath),
          name: String(item?.label || item?.name || rootPath).trim(),
          path: rootPath,
          volumeName: String(item?.label || '').trim(),
          fileSystem: String(item?.fstype || '').trim(),
          size: toSafeInt(item?.size),
          freeSpace: 0,
          driveType: null,
          driveTypeLabel: isUsb ? 'usb' : rm ? 'removable' : 'hotplug',
          isUsb,
          isRemovable: true
        })
      }
      const children = Array.isArray(item?.children) ? item.children : []
      for (const child of children) walk(child)
    }

    const devices = Array.isArray(parsed?.blockdevices) ? parsed.blockdevices : []
    for (const device of devices) walk(device)
    return rows
  } catch (error) {
    log.error('[pioneer-device-library] linux removable drive detection failed', error)
    return []
  }
}

async function listMacRemovableDrives(): Promise<BaseDriveRow[]> {
  try {
    const volumesRoot = '/Volumes'
    const exists = await fs.pathExists(volumesRoot)
    if (!exists) return []
    const entries = await fs.readdir(volumesRoot, { withFileTypes: true })
    const rows: BaseDriveRow[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const rootPath = normalizeDriveRoot(path.join(volumesRoot, entry.name))
      if (!rootPath) continue

      try {
        const info = (await runMacPlistCommand('diskutil', ['info', '-plist', rootPath])) as Record<
          string,
          any
        >
        const mountPoint = typeof info?.MountPoint === 'string' ? info.MountPoint.trim() : ''
        if (!mountPoint) continue

        const normalizedMountPoint = normalizeDriveRoot(mountPoint)
        if (!normalizedMountPoint) continue

        const protocol = String(info?.BusProtocol || info?.Protocol || '').trim()
        const protocolLower = protocol.toLowerCase()
        const internal = Boolean(info?.Internal)
        const ejectable = Boolean(info?.Ejectable)
        const isUsb = protocolLower.includes('usb')
        const isRemovable =
          !internal &&
          (ejectable ||
            isUsb ||
            protocolLower.includes('firewire') ||
            protocolLower.includes('thunderbolt') ||
            protocolLower.includes('sd'))
        if (!isRemovable) continue

        const volumeName = String(
          info?.VolumeName || info?.MediaName || entry.name || normalizedMountPoint
        ).trim()
        const fileSystem = String(
          info?.FilesystemName || info?.FileSystemName || info?.FilesystemType || ''
        ).trim()
        rows.push({
          id: String(info?.DeviceIdentifier || normalizedMountPoint).trim() || normalizedMountPoint,
          name: volumeName || normalizedMountPoint,
          path: normalizedMountPoint,
          volumeName,
          fileSystem,
          size: toSafeInt(info?.TotalSize),
          freeSpace: toSafeInt(info?.FreeSpace),
          driveType: null,
          driveTypeLabel: protocol || (ejectable ? 'ejectable' : 'external'),
          isUsb,
          isRemovable: true
        })
      } catch (error) {
        log.warn('[pioneer-device-library] mac diskutil probe failed', {
          path: rootPath,
          error
        })
      }
    }
    return rows.sort((left, right) =>
      left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })
    )
  } catch (error) {
    log.error('[pioneer-device-library] mac removable drive detection failed', error)
    return []
  }
}

export async function listPioneerRemovableDrives(): Promise<PioneerRemovableDriveInfo[]> {
  let baseRows: BaseDriveRow[] = []
  if (process.platform === 'win32') {
    baseRows = await listWindowsRemovableDrives()
  } else if (process.platform === 'linux') {
    baseRows = await listLinuxRemovableDrives()
  } else if (process.platform === 'darwin') {
    baseRows = await listMacRemovableDrives()
  }

  const results: PioneerRemovableDriveInfo[] = []
  for (const baseRow of baseRows) {
    try {
      const pioneer = await probePioneerDeviceLibraryRoot(baseRow.path)
      results.push({
        ...baseRow,
        isPioneerDeviceLibrary: pioneer.hasExportPdb,
        pioneer
      })
    } catch (error) {
      log.warn('[pioneer-device-library] pioneer probe failed', {
        path: baseRow.path,
        error
      })
      results.push({
        ...baseRow,
        isPioneerDeviceLibrary: false,
        pioneer: {
          hasPioneerFolder: false,
          hasRekordboxFolder: false,
          hasExportPdb: false,
          hasUsbAnlzFolder: false,
          pioneerFolderPath: null,
          rekordboxFolderPath: null,
          exportPdbPath: null,
          usbAnlzPath: null
        }
      })
    }
  }

  return results.sort((left, right) =>
    left.path.localeCompare(right.path, undefined, { sensitivity: 'base' })
  )
}
