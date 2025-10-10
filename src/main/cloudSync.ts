import { ipcMain } from 'electron'
import fs = require('fs-extra')
import { is } from '@electron-toolkit/utils'
import store from './store'
import url from './url'
import FingerprintStore from './fingerprintStore'
import { log } from './log'
import mainWindow from './window/mainWindow'

const CLOUD_SYNC = {
  BASE_URL: is.dev
    ? process.env.CLOUD_SYNC_BASE_URL_DEV || 'http://localhost:3001'
    : process.env.CLOUD_SYNC_BASE_URL_PROD || '',
  PREFIX: '/frkbapi/v1/fingerprint-sync',
  API_SECRET_KEY: process.env.CLOUD_SYNC_API_SECRET_KEY || ''
}

const DEV_DEFAULT_USER_KEY = '5de44d53-6236-4df6-84ab-382ac0717bc0'

type CloudSyncConfig = { userKey?: string }
let cloudSyncConfig: CloudSyncConfig = {}

// 简单的全局节流器：相邻请求至少间隔 650ms，保证每分钟 <= 100 次
const RATE_LIMIT_MIN_INTERVAL_MS = 650
function createRateLimiter(minIntervalMs: number) {
  let nextAvailableAt = 0
  return async function limitOnce() {
    const now = Date.now()
    const scheduledAt = Math.max(now, nextAvailableAt)
    const waitMs = Math.max(0, scheduledAt - now)
    nextAvailableAt = scheduledAt + minIntervalMs
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
}
const limitRequestOnce = createRateLimiter(RATE_LIMIT_MIN_INTERVAL_MS)
async function limitedFetch(input: any, init?: any) {
  await limitRequestOnce()
  return fetch(input, init)
}

// 同步启动频控：5 分钟内最多 10 次
const SYNC_WINDOW_MS = 5 * 60 * 1000
const SYNC_MAX_IN_WINDOW = 10
let syncStartTimestamps: number[] = []
function canStartSyncNow() {
  const now = Date.now()
  syncStartTimestamps = syncStartTimestamps.filter((t) => now - t < SYNC_WINDOW_MS)
  return syncStartTimestamps.length < SYNC_MAX_IN_WINDOW
}
function markSyncStarted() {
  syncStartTimestamps.push(Date.now())
}

// 将后端错误结构标准化为前端 i18n key（避免直接透传中文 message）
function mapBackendErrorToI18nKey(payload: any): string {
  const error = String(payload?.error || '').toUpperCase()
  switch (error) {
    case 'INVALID_API_KEY':
      return 'cloudSync.errors.cannotConnect'
    case 'INVALID_USER_KEY':
    case 'USER_KEY_NOT_FOUND':
      return 'cloudSync.errors.keyInvalid'
    case 'USER_KEY_INACTIVE':
      return 'cloudSync.errors.keyDisabled'
    case 'DIFF_SESSION_NOT_FOUND':
      return 'cloudSync.errors.sessionNotExist'
    case 'DIFF_SESSION_USER_MISMATCH':
      return 'cloudSync.errors.keyMismatch'
    case 'REQUEST_TOO_LARGE':
      return 'cloudSync.errors.requestTooLarge'
    case 'VALIDATION_ERROR':
      return 'cloudSync.errors.validationFailed'
    case 'SYNC_RATE_LIMIT_EXCEEDED':
    case 'RATE_LIMIT_EXCEEDED':
      return 'cloudSync.errors.tooFrequent'
    case 'STRICT_RATE_LIMIT_EXCEEDED':
      return 'cloudSync.errors.sensitiveOperationTooFrequent'
    case 'FINGERPRINT_LIMIT_EXCEEDED':
      return 'cloudSync.errors.limitExceeded'
  }
  const backendMsg = String(payload?.message || '')
  if (backendMsg.includes('请求参数验证失败')) return 'cloudSync.errors.validationFailed'
  if (backendMsg.includes('分页拉取差异数据失败')) return 'cloudSync.errors.pullDiffPageFailed'
  if (backendMsg.includes('请求体大小超过限制')) return 'cloudSync.errors.requestTooLarge'
  return 'cloudSync.errors.validationFailed'
}

async function validateUserKeyRequest(userKeyRaw: string) {
  const userKey = (userKeyRaw || '').trim()
  const requestBody = { userKey }
  if (is.dev) {
    log.info('[cloudSync] /validate-user-key request', {
      url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/validate-user-key`,
      headers: {
        Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: requestBody
    })
  }
  const res = await limitedFetch(`${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/validate-user-key`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  })
  const json = await res.json()
  if (is.dev) {
    log.info('[cloudSync] /validate-user-key response', { status: res.status, json })
  }
  return json
}

ipcMain.handle('cloudSync/config/get', () => {
  let storedUserKey =
    cloudSyncConfig.userKey || (store as any).settingConfig?.cloudSyncUserKey || ''
  if (!storedUserKey && is.dev) {
    storedUserKey = DEV_DEFAULT_USER_KEY
    cloudSyncConfig.userKey = storedUserKey
    ;(store as any).settingConfig.cloudSyncUserKey = storedUserKey
    fs.outputJson(url.settingConfigFileUrl, (store as any).settingConfig)
  } else {
    cloudSyncConfig.userKey = storedUserKey
  }
  // 同步当前指纹模式给渲染层
  const mode = ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
  return { userKey: storedUserKey, mode }
})

// 重置用户云端数据（不重置使用统计）
ipcMain.handle('cloudSync/resetUserData', async (_e, payload: { notes?: string }) => {
  try {
    const userKey = (cloudSyncConfig.userKey || '').trim()
    if (!userKey) {
      return { success: false, message: 'cloudSync.notConfigured' }
    }
    const body: any = { userKey }
    if (payload && typeof payload.notes === 'string' && payload.notes.trim()) {
      body.notes = payload.notes.trim()
    }
    if (is.dev) {
      log.info('[cloudSync] /reset request', {
        url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/reset`,
        headers: {
          Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body
      })
    }
    const res = await limitedFetch(`${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/reset`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    const json = await res.json()
    if (is.dev) {
      log.info('[cloudSync] /reset response', { status: res.status, json })
    }
    if (json?.success === true) {
      return { success: true, data: json }
    }
    // 失败：按后端错误码映射提示
    const messageKey = mapBackendErrorToI18nKey(json)
    return { success: false, message: messageKey, error: json }
  } catch (e) {
    log.error('[cloudSync] /reset failed', e)
    return { success: false, message: 'cloudSync.errors.cannotConnect' }
  }
})

ipcMain.handle('cloudSync/config/save', async (_e, payload: { userKey: string }) => {
  const userKey = (payload?.userKey || '').trim()
  try {
    const json = await validateUserKeyRequest(userKey)
    if (json?.success === true && json?.data?.isActive === true) {
      cloudSyncConfig.userKey = json?.data?.userKey || userKey
      ;(store as any).settingConfig.cloudSyncUserKey = cloudSyncConfig.userKey
      await fs.outputJson(url.settingConfigFileUrl, (store as any).settingConfig)
      return { success: true }
    }
    const error = String(json?.error || '').toUpperCase()
    if (error === 'INVALID_USER_KEY' || error === 'USER_KEY_NOT_FOUND') {
      return { success: false, message: 'cloudSync.errors.keyInvalid' }
    }
    if (error === 'USER_KEY_INACTIVE' || json?.data?.isActive === false) {
      return { success: false, message: 'cloudSync.errors.keyDisabled' }
    }
    return { success: false, message: 'cloudSync.errors.cannotConnect' }
  } catch (_err) {
    return { success: false, message: 'cloudSync.errors.cannotConnect' }
  }
})

// 计算指纹集合哈希（与后端一致）
// - 统一小写
// - 升序排序
// - 直接拼接（无分隔符）
// - sha256 输出 hex 小写
// - 空数组等价于 sha256('')
function calculateCollectionHashForSet(crypto: any, fingerprints: string[]): string {
  if (!Array.isArray(fingerprints)) {
    throw new Error('指纹数组参数无效')
  }
  if (fingerprints.length === 0) {
    return crypto.createHash('sha256').update('', 'utf8').digest('hex')
  }
  const concatenated = fingerprints
    .map((fp) => String(fp).toLowerCase())
    .sort()
    .join('')
  return crypto.createHash('sha256').update(concatenated, 'utf8').digest('hex')
}

ipcMain.handle('cloudSync/testConnectivity', async (_e, payload: { userKey: string }) => {
  try {
    const json = await validateUserKeyRequest(payload?.userKey || '')
    if (json?.success === true && json?.data?.isActive === true) {
      const limitNum = Number(json?.limit)
      return {
        success: true,
        message: 'cloudSync.connectivityOk',
        limit: Number.isFinite(limitNum) ? limitNum : undefined
      }
    }
    const error = String(json?.error || '').toUpperCase()
    if (error === 'INVALID_USER_KEY' || error === 'USER_KEY_NOT_FOUND') {
      return { success: false, message: 'cloudSync.errors.keyInvalid' }
    }
    if (error === 'USER_KEY_INACTIVE' || json?.data?.isActive === false) {
      return { success: false, message: 'cloudSync.errors.keyDisabled' }
    }
    return { success: false, message: 'cloudSync.errors.cannotConnect' }
  } catch (_err) {
    return { success: false, message: 'cloudSync.errors.cannotConnect' }
  }
})

// 仅获取当前 userKey 的配额上限（通过 /check 读取 limit 字段），不进入同步流程
// 不再需要独立的 fetchLimit，后端已在 validate-user-key 返回 limit

ipcMain.handle('cloudSync/start', async () => {
  // 频控：限制 5 分钟内最多 10 次同步启动
  // 在接近上限时（第 9 次或第 10 次）给出友好提示并告知下一次安全操作时间
  {
    const now = Date.now()
    const windowTs = syncStartTimestamps.filter((t) => now - t < SYNC_WINDOW_MS)
    if (windowTs.length >= SYNC_MAX_IN_WINDOW) {
      const oldestTs = windowTs[0] ?? now
      const retryAfterMs = Math.max(0, SYNC_WINDOW_MS - (now - oldestTs))
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('cloudSync/error', {
          message: '操作过于频繁：5 分钟内最多允许发起 10 次同步',
          error: {
            code: 'RATE_LIMITED',
            scope: 'sync_start',
            windowMs: SYNC_WINDOW_MS,
            max: SYNC_MAX_IN_WINDOW,
            retryAfterMs
          }
        })
        mainWindow.instance.webContents.send('cloudSync/state', 'failed')
      }
      return 'rate_limited'
    }
    // 第 9 次（窗口内已有 8 次，将要发起第 9 次）或第 10 次（已有 9 次，将要发起第 10 次）给提示
    if (windowTs.length === SYNC_MAX_IN_WINDOW - 2 || windowTs.length === SYNC_MAX_IN_WINDOW - 1) {
      const oldestTs = windowTs[0] ?? now
      const retryAfterMs = Math.max(0, SYNC_WINDOW_MS - (now - oldestTs))
      const seconds = Math.ceil(retryAfterMs / 1000)
      const msg =
        windowTs.length === SYNC_MAX_IN_WINDOW - 2
          ? `温馨提示：5 分钟内已累计 8 次同步，本次为第 9 次。为避免触发限制，建议在 ${seconds} 秒后再次发起同步。`
          : `温馨提示：5 分钟内已累计 9 次同步，本次为第 10 次。再次发起同步前，请等待 ${seconds} 秒。`
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('cloudSync/notice', {
          message: msg,
          code: 'rate_limit_warning',
          currentInWindow: windowTs.length,
          windowMs: SYNC_WINDOW_MS,
          max: SYNC_MAX_IN_WINDOW,
          retryAfterMs
        })
      }
    }
  }
  if (!canStartSyncNow()) {
    const now = Date.now()
    // 重新清理一次，确保时间戳窗口准确
    syncStartTimestamps = syncStartTimestamps.filter((t) => now - t < SYNC_WINDOW_MS)
    const oldestTs = syncStartTimestamps[0] ?? now
    const retryAfterMs = Math.max(0, SYNC_WINDOW_MS - (now - oldestTs))
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('cloudSync/error', {
        message: '操作过于频繁：5 分钟内最多允许发起 10 次同步',
        error: {
          code: 'RATE_LIMITED',
          scope: 'sync_start',
          windowMs: SYNC_WINDOW_MS,
          max: SYNC_MAX_IN_WINDOW,
          retryAfterMs
        }
      })
      mainWindow.instance.webContents.send('cloudSync/state', 'failed')
    }
    return 'rate_limited'
  }
  markSyncStarted()
  if (!cloudSyncConfig.userKey) {
    if (is.dev) {
      cloudSyncConfig.userKey = DEV_DEFAULT_USER_KEY
    } else {
      return 'not_configured'
    }
  }

  let cancelRequested = false
  ipcMain.once('cloudSync/cancel', () => {
    cancelRequested = true
  })

  const sendProgress = (phase: string, percent: number, details?: any) => {
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('cloudSync/progress', { phase, percent, details })
    }
  }
  const sendState = (state: 'syncing' | 'success' | 'failed' | 'cancelled') => {
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('cloudSync/state', state)
    }
  }
  const sendError = (message: string, error?: any) => {
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('cloudSync/error', { message, error })
    }
  }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  try {
    sendState('syncing')
    const startAt = Date.now()
    const pad = (n: number) => String(n).padStart(2, '0')
    const formatTs = (ms: number) => {
      const d = new Date(ms)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }
    let addedToServerTotal = 0
    const toNumber = (v: any, fallback = 0) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : fallback
    }
    // 服务器端为当前 userKey 设置的上限（来自 /check）
    let serverLimit: number | null = null
    // 不再掩码敏感信息，应用户要求完整打印

    // 读取本地集合（存储为 SHA256，小写、去重），后端接口已统一为 64hex SHA256
    const crypto = await import('crypto')
    // 选择当前模式的本地集合
    const clientFingerprints = Array.from(
      new Set<string>((store.songFingerprintList || []).map((m) => String(m).toLowerCase()))
    )

    // 0) validate-user-key：在进入流程前快速校验 userKey 是否有效且启用
    try {
      const valid = await validateUserKeyRequest(cloudSyncConfig.userKey)
      if (!(valid?.success === true && valid?.data?.isActive === true)) {
        const errorCode = String(valid?.error || 'INVALID_USER_KEY').toUpperCase()
        const msg =
          errorCode === 'USER_KEY_INACTIVE'
            ? 'cloudSync.errors.keyDisabled'
            : errorCode === 'USER_KEY_NOT_FOUND' || errorCode === 'INVALID_USER_KEY'
              ? 'cloudSync.errors.keyInvalid'
              : 'cloudSync.errors.cannotConnect'
        // 仅错误场景记录日志（包含请求参数与返回结果）
        log.error('[cloudSync] /validate-user-key error', {
          request: {
            url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/validate-user-key`,
            body: { userKey: cloudSyncConfig.userKey }
          },
          response: valid
        })
        sendError(msg, { error: errorCode })
        sendState('failed')
        return 'failed'
      }
    } catch (_e) {
      log.error('[cloudSync] /validate-user-key network error', {
        request: {
          url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/validate-user-key`,
          body: { userKey: cloudSyncConfig.userKey }
        },
        error: _e
      })
      sendError('cloudSync.errors.cannotConnect', { error: 'NETWORK' })
      sendState('failed')
      return 'failed'
    }

    // 1) /check（集合哈希：小写、升序、无分隔符；空数组等价于 sha256('')）
    const hash = calculateCollectionHashForSet(crypto, clientFingerprints)
    const mode = ((store as any).settingConfig?.fingerprintMode as 'pcm' | 'file') || 'pcm'
    if (is.dev) {
      log.info('[cloudSync] /check request', {
        url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/check`,
        headers: {
          Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: { userKey: cloudSyncConfig.userKey, count: clientFingerprints.length, hash, mode }
      })
    }
    const checkRes = await limitedFetch(`${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/check`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        userKey: cloudSyncConfig.userKey,
        count: clientFingerprints.length,
        hash,
        mode
      })
    })
    const checkJson = await checkRes.json()
    if (is.dev) {
      log.info('[cloudSync] /check response', { status: checkRes.status, json: checkJson })
    }
    if (!checkJson?.success) {
      log.error('[cloudSync] /check error', {
        request: {
          url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/check`,
          body: { userKey: cloudSyncConfig.userKey, count: clientFingerprints.length, hash }
        },
        status: checkRes.status,
        response: checkJson
      })
      sendError(mapBackendErrorToI18nKey(checkJson), checkJson)
      sendState('failed')
      return 'failed'
    }
    // 最新后端返回顶层字段
    const serverCount = toNumber(checkJson?.serverCount)
    const clientCount = toNumber(checkJson?.clientCount)
    const limitFromServer = toNumber(checkJson?.limit, 0)
    if (Number.isFinite(limitFromServer) && limitFromServer > 0) {
      serverLimit = limitFromServer
    }
    const needSync = checkJson?.needSync === true
    sendProgress('checking', 5, { clientCount, serverCount })
    // 配额上限预检查：若客户端集合数量已大于上限，直接终止
    if (serverLimit && clientCount > serverLimit) {
      log.error('[cloudSync] limit exceeded on /check precheck', {
        limit: serverLimit,
        clientCount,
        serverCount
      })
      sendError('cloudSync.errors.limitExceededOnCheck', {
        code: 'FINGERPRINT_LIMIT_EXCEEDED',
        details: {
          phase: 'check',
          limit: serverLimit,
          clientCount,
          serverCount
        }
      })
      sendState('failed')
      return 'failed'
    }
    if (!needSync) {
      sendProgress('finalizing', 90)
      await wait(120)
      sendProgress('finalizing', 100)
      if (mainWindow.instance) {
        mainWindow.instance.webContents.send('cloudSync/notice', {
          message: 'cloudSync.errors.alreadyLatest'
        })
      }
      sendState('success')
      return 'success'
    }

    // 2) diff_up 分批
    const batchSize = 1000
    const toAdd: string[] = []
    for (let i = 0; i < clientFingerprints.length; i += batchSize) {
      if (cancelRequested) {
        sendState('cancelled')
        return 'cancelled'
      }
      const batch = clientFingerprints.slice(i, i + batchSize)
      if (is.dev) {
        log.info('[cloudSync] /bidirectional-diff request', {
          url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/bidirectional-diff`,
          headers: {
            Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: {
            userKey: cloudSyncConfig.userKey,
            clientFingerprints: batch,
            batchIndex: Math.floor(i / batchSize),
            batchSize,
            mode
          }
        })
      }
      const diffRes = await limitedFetch(
        `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/bidirectional-diff`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            userKey: cloudSyncConfig.userKey,
            clientFingerprints: batch,
            batchIndex: Math.floor(i / batchSize),
            batchSize,
            mode
          })
        }
      )
      const diffJson = await diffRes.json()
      if (is.dev) {
        log.info('[cloudSync] /bidirectional-diff response', {
          status: diffRes.status,
          json: diffJson
        })
      }
      // 最新后端返回顶层字段
      const missingServer: string[] = diffJson?.serverMissingFingerprints
      if (!diffJson?.success) {
        log.error('[cloudSync] /bidirectional-diff error', {
          request: {
            url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/bidirectional-diff`,
            body: {
              userKey: cloudSyncConfig.userKey,
              clientFingerprints: batch,
              batchIndex: Math.floor(i / batchSize),
              batchSize
            }
          },
          status: diffRes.status,
          response: diffJson
        })
        sendError(mapBackendErrorToI18nKey(diffJson), diffJson)
        sendState('failed')
        return 'failed'
      }
      if (Array.isArray(missingServer)) {
        for (const m of missingServer) toAdd.push(String(m).toLowerCase())
      }
      const progressBase = 5
      const diffPortion = 30
      const progress =
        progressBase +
        Math.min(
          ((i + batch.length) / Math.max(clientFingerprints.length, 1)) * diffPortion,
          diffPortion
        )
      sendProgress('diffing', Math.round(progress), { toAddCount: toAdd.length })
    }
    const uploadList = Array.from(new Set(toAdd))
    // 3) analyze-diff
    const clientForAnalyze = clientFingerprints
    if (is.dev) {
      log.info('[cloudSync] /analyze-diff request', {
        url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/analyze-diff`,
        headers: {
          Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: { userKey: cloudSyncConfig.userKey, clientFingerprints: clientForAnalyze, mode }
      })
    }
    const analyzeRes = await limitedFetch(
      `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/analyze-diff`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userKey: cloudSyncConfig.userKey,
          clientFingerprints: clientForAnalyze,
          mode
        })
      }
    )
    const analyzeJson = await analyzeRes.json()
    if (is.dev) {
      log.info('[cloudSync] /analyze-diff response', {
        status: analyzeRes.status,
        json: analyzeJson
      })
    }
    // 最新后端返回顶层字段
    let diffSessionId: string = analyzeJson?.diffSessionId
    const stats = analyzeJson?.diffStats || {}
    const clientMissingCount = Number(stats.clientMissingCount ?? 0)
    const pageSizeFromAnalysis = Number(stats.pageSize ?? 1000)
    if (!analyzeJson?.success) {
      log.error('[cloudSync] /analyze-diff error', {
        request: {
          url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/analyze-diff`,
          body: { userKey: cloudSyncConfig.userKey, clientFingerprints: clientForAnalyze }
        },
        status: analyzeRes.status,
        response: analyzeJson
      })
      sendError(mapBackendErrorToI18nKey(analyzeJson), analyzeJson)
      sendState('failed')
      return 'failed'
    }
    sendProgress('analyzing', 40)

    // 4) pull-diff-page 分页
    const totalPages: number = Math.ceil(clientMissingCount / Math.max(pageSizeFromAnalysis, 1))
    const mergedSet = new Set<string>(clientFingerprints)
    for (let page = 0; page < totalPages; page++) {
      if (cancelRequested) {
        sendState('cancelled')
        return 'cancelled'
      }
      if (is.dev) {
        log.info('[cloudSync] /pull-diff-page request', {
          url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/pull-diff-page`,
          headers: {
            Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: { userKey: cloudSyncConfig.userKey, diffSessionId, pageIndex: page, mode }
        })
      }
      const pageRes = await limitedFetch(
        `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/pull-diff-page`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            userKey: cloudSyncConfig.userKey,
            diffSessionId,
            pageIndex: page,
            mode
          })
        }
      )
      const pageJson = await pageRes.json()
      if (is.dev) {
        log.info('[cloudSync] /pull-diff-page response', { status: pageRes.status, json: pageJson })
      }
      // 最新后端返回顶层字段
      const missingArr: string[] = pageJson?.missingFingerprints
      if (!pageJson?.success) {
        if (pageJson?.error === 'DIFF_SESSION_NOT_FOUND') {
          page = -1
          log.error('[cloudSync] /pull-diff-page error: diff session expired', {
            request: {
              url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/pull-diff-page`,
              body: { userKey: cloudSyncConfig.userKey, diffSessionId, pageIndex: page }
            },
            status: pageRes.status,
            response: pageJson
          })
          if (is.dev) {
            log.info('[cloudSync] /analyze-diff retry request', {
              url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/analyze-diff`,
              headers: {
                Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
                'Content-Type': 'application/json'
              },
              body: { userKey: cloudSyncConfig.userKey, clientFingerprints: clientForAnalyze }
            })
          }
          const retryAnalyze = await limitedFetch(
            `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/analyze-diff`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                userKey: cloudSyncConfig.userKey,
                clientFingerprints: clientForAnalyze
              })
            }
          )
          const retryAnalyzeJson = await retryAnalyze.json()
          if (is.dev) {
            log.info('[cloudSync] /analyze-diff retry response', {
              status: retryAnalyze.status,
              json: retryAnalyzeJson
            })
          }
          if (!retryAnalyzeJson?.success) {
            log.error('[cloudSync] /analyze-diff retry error', {
              request: {
                url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/analyze-diff`,
                body: { userKey: cloudSyncConfig.userKey, clientFingerprints: clientForAnalyze }
              },
              status: retryAnalyze.status,
              response: retryAnalyzeJson
            })
            sendError(mapBackendErrorToI18nKey(retryAnalyzeJson), retryAnalyzeJson)
            sendState('failed')
            return 'failed'
          }
          diffSessionId = retryAnalyzeJson?.diffSessionId
          continue
        }
        log.error('[cloudSync] /pull-diff-page error', {
          request: {
            url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/pull-diff-page`,
            body: { userKey: cloudSyncConfig.userKey, diffSessionId, pageIndex: page }
          },
          status: pageRes.status,
          response: pageJson
        })
        sendError(mapBackendErrorToI18nKey(pageJson), pageJson)
        sendState('failed')
        return 'failed'
      }
      const missing: string[] = Array.isArray(missingArr) ? missingArr : []
      for (const m of missing) mergedSet.add(String(m).toLowerCase())
      const pullPortion = 30
      const progress = 45 + ((page + 1) / Math.max(totalPages, 1)) * pullPortion
      sendProgress('pulling', Math.round(progress), { pulledPages: page + 1, totalPages })
    }

    // 5) commit：先 /add 再本地原子替换
    // 在提交到服务端之前进行本地上限预估
    if (serverLimit && serverLimit > 0) {
      const uniqueNewCount = uploadList.length
      const allowedAddCount = Math.max(0, serverLimit - serverCount)
      if (serverCount + uniqueNewCount > serverLimit) {
        log.error('[cloudSync] pre-add limit exceeded', {
          limit: serverLimit,
          currentCount: serverCount,
          uniqueNewCount,
          allowedAddCount
        })
        sendError('cloudSync.errors.limitExceeded', {
          code: 'FINGERPRINT_LIMIT_EXCEEDED',
          details: {
            phase: 'batch_add',
            limit: serverLimit,
            currentCount: serverCount,
            uniqueNewCount,
            allowedAddCount
          }
        })
        sendState('failed')
        return 'failed'
      }
    }
    sendProgress('committing', 78)
    let committedCount = 0
    for (let i = 0; i < uploadList.length; i += batchSize) {
      const slice = uploadList.slice(i, i + batchSize)
      if (is.dev) {
        log.info('[cloudSync] /add request', {
          url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/add`,
          headers: {
            Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: { userKey: cloudSyncConfig.userKey, addFingerprints: slice, mode }
        })
      }
      const addRes = await limitedFetch(`${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/add`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ userKey: cloudSyncConfig.userKey, addFingerprints: slice, mode })
      })
      const addJson = await addRes.json()
      if (is.dev) {
        log.info('[cloudSync] /add response', { status: addRes.status, json: addJson })
      }
      const addedCount = toNumber(addJson?.addedCount)
      if (!addJson?.success) {
        log.error('[cloudSync] /add error', {
          request: {
            url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/add`,
            body: { userKey: cloudSyncConfig.userKey, addFingerprints: slice }
          },
          status: addRes.status,
          response: addJson
        })
        sendError(mapBackendErrorToI18nKey(addJson), addJson)
        sendState('failed')
        return 'failed'
      }
      addedToServerTotal += addedCount
      committedCount += slice.length
      const ratio = uploadList.length > 0 ? Math.min(committedCount / uploadList.length, 1) : 1
      const progress = 78 + Math.round(ratio * 14) // 78 -> 92
      sendProgress('committing', progress)
    }
    if (uploadList.length === 0) {
      sendProgress('committing', 85)
    }

    // 本地保存（多版本+指针，原子切换）
    const mergedList = Array.from(mergedSet)
    await FingerprintStore.saveList(mergedList)

    // 6) 提交后复查 /check
    sendProgress('finalizing', 93)
    const verifyHash = calculateCollectionHashForSet(crypto, mergedList)
    let verifiedHashMatched = false
    let serverFinalCount = toNumber(serverCount)
    try {
      if (is.dev) {
        log.info('[cloudSync] /check verify request', {
          url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/check`,
          headers: {
            Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: {
            userKey: cloudSyncConfig.userKey,
            count: mergedList.length,
            hash: verifyHash,
            mode
          }
        })
      }
      const verifyRes = await limitedFetch(`${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/check`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CLOUD_SYNC.API_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userKey: cloudSyncConfig.userKey,
          count: mergedList.length,
          hash: verifyHash,
          mode
        })
      })
      const verifyJson = await verifyRes.json()
      if (is.dev) {
        log.info('[cloudSync] /check verify response', {
          status: verifyRes.status,
          json: verifyJson
        })
      }
      if (!verifyJson?.success) {
        log.error('[cloudSync] /check verify error', {
          request: {
            url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/check`,
            body: { userKey: cloudSyncConfig.userKey, count: mergedList.length, hash: verifyHash }
          },
          status: verifyRes.status,
          response: verifyJson
        })
      }
      if (verifyJson?.success) {
        verifiedHashMatched = verifyJson?.needSync === false
        serverFinalCount = toNumber(verifyJson?.serverCount, serverFinalCount)
      }
    } catch (_e) {
      // 错误需记录日志，但不影响主流程
      log.error('[cloudSync] /check verify network error', {
        request: {
          url: `${CLOUD_SYNC.BASE_URL}${CLOUD_SYNC.PREFIX}/check`,
          body: { userKey: cloudSyncConfig.userKey, count: mergedList.length, hash: verifyHash }
        },
        error: _e
      })
    }

    sendProgress('finalizing', 95)
    await wait(120)
    sendProgress('finalizing', 100)
    const endAt = Date.now()
    const pulledToClientCount = Math.max(0, mergedList.length - clientFingerprints.length)
    const summary = {
      startAt: formatTs(startAt),
      endAt: formatTs(endAt),
      durationMs: endAt - startAt,
      clientInitialCount: toNumber(clientFingerprints.length),
      serverInitialCount: toNumber(serverCount),
      addedToServerCount: toNumber(addedToServerTotal),
      pulledToClientCount,
      totalClientCountAfter: toNumber(mergedList.length),
      totalServerCountAfter: toNumber(serverFinalCount),
      verifiedHashMatched
    }
    if (mainWindow.instance) {
      mainWindow.instance.webContents.send('cloudSync/summary', summary)
    }
    sendState('success')
    store.songFingerprintList = mergedList
    return 'success'
  } catch (e: any) {
    const msg = (() => {
      const rawMsg = String(e?.message || '')
      const code = String((e?.cause && e.cause.code) || e?.code || '')
      const isNetwork =
        rawMsg.includes('fetch failed') ||
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        code === 'ETIMEDOUT' ||
        code === 'EAI_AGAIN'
      if (isNetwork) return 'cloudSync.errors.cannotConnect'
      return 'common.error'
    })()
    // 捕获到的最终错误需记录
    log.error('[cloudSync] sync failed', { error: e, message: msg })
    sendError(msg, e)
    sendState('failed')
    return 'failed'
  }
})
