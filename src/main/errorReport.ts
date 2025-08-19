import { ipcMain } from 'electron'
import fs = require('fs-extra')
import path = require('path')
import { is } from '@electron-toolkit/utils'
import store from './store'
import url from './url'
import { log } from './log'

// 正式阈值：累计运行 100 小时上报一次；失败后每 1 小时重试一次
const USAGE_UPLOAD_THRESHOLD_MS = 100 * 60 * 60 * 1000
const RETRY_THRESHOLD_MS = 60 * 60 * 1000
const TICK_MS = 5000

const ERROR_API = {
  BASE_URL: is.dev ? 'http://localhost:3001' : 'http://106.54.200.160:3001',
  PATH: '/frkbapi/v1/error-report/upload',
  API_SECRET_KEY: 'FRKB_73726add-497c-4c30-b340-ba3b94e9788d'
}

let timer: NodeJS.Timeout | null = null

function getLogFilePath() {
  // log.ts中通过 resolvePathFn 指定了 userDataDir/log.txt
  return path.join(url.userDataDir, 'log.txt')
}

async function readLogText(): Promise<string> {
  try {
    const file = getLogFilePath()
    if (!(await fs.pathExists(file))) return ''
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size <= 0) return ''
    const text = await fs.readFile(file, 'utf8')
    return text || ''
  } catch (e) {
    log.error('[errorReport] 读取日志失败', e)
    return ''
  }
}

async function clearLogFile() {
  try {
    const file = getLogFilePath()
    await fs.outputFile(file, '')
  } catch (e) {
    log.error('[errorReport] 清空日志失败', e)
  }
}

async function uploadLogText(text: string): Promise<boolean> {
  try {
    const res = await fetch(`${ERROR_API.BASE_URL}${ERROR_API.PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ERROR_API.API_SECRET_KEY}`,
        'Content-Type': 'text/plain'
      },
      body: text
    })
    const json = await res.json().catch(() => ({}))
    const ok = res.ok && json?.success === true
    if (!ok) {
      log.error('[errorReport] 上报失败', { status: res.status, json })
    }
    return ok
  } catch (e) {
    log.error('[errorReport] 上报异常', e)
    return false
  }
}

function persistSettings() {
  try {
    fs.outputJson(url.settingConfigFileUrl, store.settingConfig)
  } catch (e) {
    log.error('[errorReport] 持久化设置失败', e)
  }
}

async function tryUploadOnce(trigger: 'auto' | 'manual'): Promise<boolean> {
  const setting: any = store.settingConfig || {}
  const text = await readLogText()
  if (!text || !text.trim()) {
    // 日志为空：自动触发时重置累计时长，避免每个 tick 都重复尝试
    if (trigger === 'auto') {
      setting.errorReportUsageMsSinceLastSuccess = 0
      persistSettings()
    }
    return false
  }
  const success = await uploadLogText(text)
  if (success) {
    await clearLogFile()
    setting.errorReportUsageMsSinceLastSuccess = 0
    setting.errorReportRetryMsSinceLastFailure = -1
    persistSettings()
    return true
  }
  // 失败进入重试窗口
  setting.errorReportRetryMsSinceLastFailure = 0
  persistSettings()
  return false
}

async function onTick() {
  const setting: any = store.settingConfig || {}
  if (!setting.enableErrorReport) return

  // 初始化字段
  if (typeof setting.errorReportUsageMsSinceLastSuccess !== 'number') {
    setting.errorReportUsageMsSinceLastSuccess = 0
  }
  if (typeof setting.errorReportRetryMsSinceLastFailure !== 'number') {
    setting.errorReportRetryMsSinceLastFailure = -1
  }

  // 累计运行时长
  setting.errorReportUsageMsSinceLastSuccess += TICK_MS

  // 若失败重试窗口开启，则累计重试计时
  if (setting.errorReportRetryMsSinceLastFailure >= 0) {
    setting.errorReportRetryMsSinceLastFailure += TICK_MS
    if (setting.errorReportRetryMsSinceLastFailure >= RETRY_THRESHOLD_MS) {
      await tryUploadOnce('auto')
    }
    return
  }

  // 正常阈值触发
  if (setting.errorReportUsageMsSinceLastSuccess >= USAGE_UPLOAD_THRESHOLD_MS) {
    await tryUploadOnce('auto')
  }
}

function setup() {
  if (timer) clearInterval(timer)
  timer = setInterval(onTick, TICK_MS)
}

export default { setup }
