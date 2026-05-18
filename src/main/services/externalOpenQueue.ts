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
    const audioExtSet = getAudioExtSet()
    const extSupported = audioExtSet.has(ext)
    if (!extSupported) {
      log.info('isSupportedAudioPath: 扩展名不支持', {
        filePath,
        ext,
        supportedExts: Array.from(audioExtSet)
      })
      return false
    }
    const exists = fs.pathExistsSync(filePath)
    if (!exists) {
      log.warn('isSupportedAudioPath: 文件不存在', { filePath })
    }
    return exists
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
      log.info('collectSupportedAudioPaths: 路径不支持', {
        raw,
        normalized,
        ext: path.extname(normalized)
      })
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

async function sendExternalOpenPayload(payload: ExternalOpenPayload): Promise<void> {
  if (!mainWindow.instance) return
  const wc = mainWindow.instance.webContents
  if (wc.isLoading()) {
    await new Promise<void>((resolve) => wc.once('did-finish-load', () => resolve()))
  }
  wc.send('external-open/imported', payload)
}

export function queueExternalAudioFiles(paths: string[]): void {
  log.info('queueExternalAudioFiles 收到路径', { paths, count: paths?.length })
  const accepted = collectSupportedAudioPaths(paths)
  log.info('queueExternalAudioPaths 过滤结果', { accepted, count: accepted.length })
  if (accepted.length === 0) return
  externalOpenQueue.push(...accepted)
  void processExternalOpenQueue()
}

export async function processExternalOpenQueue(): Promise<void> {
  if (processingExternalOpen) {
    log.info('processExternalOpenQueue: 正在处理中，跳过')
    return
  }
  if (!externalOpenQueue.length) {
    log.info('processExternalOpenQueue: 队列为空')
    return
  }
  if (!mainWindow.instance) {
    log.info('processExternalOpenQueue: 主窗口不存在')
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
    log.info('processExternalOpenQueue: 准备发送', { batch, count: batch.length })
    if (batch.length > 0) {
      await sendExternalOpenPayload({ paths: batch })
      log.info('processExternalOpenQueue: 发送成功')
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
