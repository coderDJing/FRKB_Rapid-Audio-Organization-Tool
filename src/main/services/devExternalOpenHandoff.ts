import crypto = require('crypto')
import nodeFs = require('fs')
import path = require('path')
import fs = require('fs-extra')
import { SUPPORTED_AUDIO_FORMATS } from '../../shared/audioFormats'
import { log } from '../log'
import { queueExternalAudioFiles } from './externalOpenQueue'

type DevExternalOpenRequest = {
  paths: string[]
  createdAtMs: number
  pid: number
}

const HANDOFF_DIR_NAME = 'external-open-requests'
const REQUEST_FILE_PREFIX = 'external-open-'
const REQUEST_FILE_SUFFIX = '.json'
const SUPPORTED_EXTENSIONS = new Set(SUPPORTED_AUDIO_FORMATS.map((format) => `.${format}`))

let watcherStarted = false
let consumeTimer: NodeJS.Timeout | null = null
let consuming = false

const resolveHandoffDir = (userDataDir: string): string => {
  return path.join(userDataDir, 'locks', HANDOFF_DIR_NAME)
}

const isRequestFileName = (fileName: string): boolean => {
  return fileName.startsWith(REQUEST_FILE_PREFIX) && fileName.endsWith(REQUEST_FILE_SUFFIX)
}

const normalizeExternalOpenArg = (raw: string): string => {
  return String(raw || '')
    .replace(/^"+|"+$/g, '')
    .trim()
}

const collectCliAudioPaths = (args: string[]): string[] => {
  const accepted: string[] = []
  const seen = new Set<string>()
  for (const raw of args || []) {
    const value = normalizeExternalOpenArg(raw)
    if (!value || value.startsWith('--')) continue
    const ext = path.extname(value).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue
    const resolved = path.resolve(value)
    try {
      if (!fs.pathExistsSync(resolved)) continue
    } catch {
      continue
    }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    accepted.push(resolved)
  }
  return accepted
}

const readRequest = async (filePath: string): Promise<DevExternalOpenRequest | null> => {
  try {
    const parsed: unknown = await fs.readJson(filePath)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const paths = Array.isArray(record.paths)
      ? record.paths.filter((item): item is string => typeof item === 'string' && !!item.trim())
      : []
    if (paths.length === 0) return null
    return {
      paths,
      createdAtMs: Number(record.createdAtMs || 0),
      pid: Number(record.pid || 0)
    }
  } catch (error) {
    log.error('[dev-external-open] 读取投递文件失败', { filePath, error })
    return null
  }
}

const consumePendingRequests = async (handoffDir: string): Promise<void> => {
  if (consuming) return
  consuming = true
  try {
    await fs.ensureDir(handoffDir)
    const fileNames = (await fs.readdir(handoffDir)).filter(isRequestFileName)
    fileNames.sort()
    for (const fileName of fileNames) {
      const filePath = path.join(handoffDir, fileName)
      const request = await readRequest(filePath)
      try {
        await fs.remove(filePath)
      } catch (error) {
        log.error('[dev-external-open] 删除投递文件失败', { filePath, error })
      }
      if (request?.paths.length) {
        queueExternalAudioFiles(request.paths)
      }
    }
  } catch (error) {
    log.error('[dev-external-open] 消费投递队列失败', error)
  } finally {
    consuming = false
  }
}

export const writeDevExternalOpenHandoff = (userDataDir: string, args: string[]): boolean => {
  const normalizedUserDataDir = String(userDataDir || '').trim()
  if (!normalizedUserDataDir) return false
  const paths = collectCliAudioPaths(args)
  if (paths.length === 0) return false

  try {
    const handoffDir = resolveHandoffDir(normalizedUserDataDir)
    fs.ensureDirSync(handoffDir)
    const request: DevExternalOpenRequest = {
      paths,
      createdAtMs: Date.now(),
      pid: process.pid
    }
    const uniqueId = `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    const targetPath = path.join(
      handoffDir,
      `${REQUEST_FILE_PREFIX}${uniqueId}${REQUEST_FILE_SUFFIX}`
    )
    const tempPath = `${targetPath}.tmp`
    fs.writeJsonSync(tempPath, request)
    fs.moveSync(tempPath, targetPath, { overwrite: false })
    return true
  } catch (error) {
    log.error('[dev-external-open] 写入投递文件失败', error)
    return false
  }
}

export const startDevExternalOpenHandoffWatcher = (userDataDir: string): void => {
  const normalizedUserDataDir = String(userDataDir || '').trim()
  if (watcherStarted || !normalizedUserDataDir) return
  watcherStarted = true
  const handoffDir = resolveHandoffDir(normalizedUserDataDir)

  const scheduleConsume = () => {
    if (consumeTimer) return
    consumeTimer = setTimeout(() => {
      consumeTimer = null
      void consumePendingRequests(handoffDir)
    }, 50)
  }

  void consumePendingRequests(handoffDir)
  try {
    fs.ensureDirSync(handoffDir)
    const watcher = nodeFs.watch(handoffDir, scheduleConsume)
    watcher.unref()
  } catch (error) {
    log.error('[dev-external-open] 监听投递目录失败', error)
  }
}
