import path = require('path')
import os = require('os')
import fs = require('fs-extra')
import type { WebContents } from 'electron'
import { log } from '../log'
import mainWindow from '../window/mainWindow'
import store from '../store'

const externalOpenQueue: string[] = []
const externalOpenSeen = new Set<string>()
let processingExternalOpen = false
let externalOpenRendererReady = false

const normalizeExternalPathKey = (p: string): string => {
  try {
    const resolved = path.resolve(p)
    return os.platform() === 'win32' ? resolved.toLowerCase() : resolved
  } catch {
    return os.platform() === 'win32' ? String(p || '').toLowerCase() : String(p || '')
  }
}

const getAudioExtSet = (): Set<string> => {
  try {
    return new Set(
      (store.settingConfig.audioExt || []).map((ext) => String(ext || '').toLowerCase())
    )
  } catch {
    return new Set<string>()
  }
}

export const isSupportedAudioPath = (filePath: string): boolean => {
  try {
    const ext = path.extname(filePath || '').toLowerCase()
    const audioExtSet = getAudioExtSet()
    const extSupported = audioExtSet.has(ext)
    if (!extSupported) {
      return false
    }
    return fs.pathExistsSync(filePath)
  } catch (error) {
    log.error('isSupportedAudioPath: 检查失败', { filePath, error })
    return false
  }
}

function collectSupportedAudioPaths(paths: string[]): string[] {
  const accepted: string[] = []
  for (const raw of paths || []) {
    if (!raw || typeof raw !== 'string') continue
    const normalized = path.resolve(String(raw).replace(/^"+|"+$/g, ''))
    const supported = isSupportedAudioPath(normalized)
    if (!supported) {
      continue
    }
    const key = normalizeExternalPathKey(normalized)
    if (externalOpenSeen.has(key)) continue
    externalOpenSeen.add(key)
    accepted.push(normalized)
  }
  return accepted
}

type ExternalOpenPayload = {
  paths: string[]
}

const getMainWindowWebContents = (): WebContents | null => {
  const target = mainWindow.instance
  if (!target || target.isDestroyed()) return null
  const wc = target.webContents
  if (!wc || wc.isDestroyed()) return null
  return wc
}

export function markExternalOpenRendererNotReady(): void {
  externalOpenRendererReady = false
}

export function markExternalOpenRendererReady(sender?: WebContents): void {
  const wc = getMainWindowWebContents()
  if (!wc) {
    externalOpenRendererReady = false
    return
  }
  if (sender && sender.id !== wc.id) return
  externalOpenRendererReady = true
  void processExternalOpenQueue()
}

async function sendExternalOpenPayload(payload: ExternalOpenPayload): Promise<boolean> {
  const wc = getMainWindowWebContents()
  if (!wc || !externalOpenRendererReady) return false
  if (wc.isLoading()) {
    externalOpenRendererReady = false
    return false
  }
  wc.send('external-open/imported', payload)
  return true
}

export function queueExternalAudioFiles(paths: string[]): void {
  const accepted = collectSupportedAudioPaths(paths)
  if (accepted.length === 0) return
  externalOpenQueue.push(...accepted)
  void processExternalOpenQueue()
}

export async function processExternalOpenQueue(): Promise<void> {
  if (processingExternalOpen) {
    return
  }
  if (!externalOpenQueue.length) {
    return
  }
  if (!mainWindow.instance || !externalOpenRendererReady) {
    return
  }
  processingExternalOpen = true
  try {
    const batch: string[] = []
    while (externalOpenQueue.length > 0) {
      const candidate = externalOpenQueue.shift()
      if (!candidate) continue
      const key = normalizeExternalPathKey(candidate)
      externalOpenSeen.delete(key)
      if (!isSupportedAudioPath(candidate)) continue
      batch.push(candidate)
    }
    if (batch.length > 0) {
      const sent = await sendExternalOpenPayload({ paths: batch })
      if (!sent) {
        for (const candidate of batch) {
          const key = normalizeExternalPathKey(candidate)
          if (externalOpenSeen.has(key)) continue
          externalOpenSeen.add(key)
          externalOpenQueue.push(candidate)
        }
      }
    }
  } catch (error) {
    log.error('处理外部音频打开队列失败', error)
  } finally {
    processingExternalOpen = false
    if (externalOpenQueue.length > 0) {
      void processExternalOpenQueue()
    }
  }
}
