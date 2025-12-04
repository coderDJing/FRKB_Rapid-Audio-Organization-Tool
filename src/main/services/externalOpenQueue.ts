import path = require('path')
import os = require('os')
import fs = require('fs-extra')
import { log } from '../log'
import mainWindow from '../window/mainWindow'
import store from '../store'

const externalOpenQueue: string[] = []
const externalOpenSeen = new Set<string>()
let processingExternalOpen = false

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
    if (!getAudioExtSet().has(ext)) return false
    return fs.pathExistsSync(filePath)
  } catch {
    return false
  }
}

function collectSupportedAudioPaths(paths: string[]): string[] {
  const accepted: string[] = []
  for (const raw of paths || []) {
    if (!raw || typeof raw !== 'string') continue
    const normalized = path.resolve(String(raw).replace(/^"+|"+$/g, ''))
    if (!isSupportedAudioPath(normalized)) continue
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

async function sendExternalOpenPayload(payload: ExternalOpenPayload): Promise<void> {
  if (!mainWindow.instance) return
  const wc = mainWindow.instance.webContents
  if (wc.isLoading()) {
    await new Promise<void>((resolve) => wc.once('did-finish-load', () => resolve()))
  }
  wc.send('external-open/imported', payload)
}

export function queueExternalAudioFiles(paths: string[]): void {
  const accepted = collectSupportedAudioPaths(paths)
  if (accepted.length === 0) return
  externalOpenQueue.push(...accepted)
  void processExternalOpenQueue()
}

export async function processExternalOpenQueue(): Promise<void> {
  if (processingExternalOpen) return
  if (!externalOpenQueue.length) return
  if (!mainWindow.instance) return
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
      await sendExternalOpenPayload({ paths: batch })
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
