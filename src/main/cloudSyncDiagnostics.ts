import { app } from 'electron'
import { isRcReleaseVersion } from '../shared/releaseNotes'
import { log } from './log'

/**
 * 云同步定时循环诊断日志（仅 RC 预发布）。
 *
 * 触发条件：当前 app 版本号匹配 `-rc`（例如 `1.2.4-rc.202609011802`）。
 * 正式版（不含 `-rc`）不写这些 info，避免用户 log.txt 被每小时同步刷满。
 * 写入现有 log.txt 链路：开发模式在项目根，打包后在 userData。
 * 后续清理：正式渠道稳定后删除对本模块的调用即可；版本号切正式版后会自动关闭。
 */
export function isCloudSyncRcLogEnabled(): boolean {
  try {
    return isRcReleaseVersion(app.getVersion())
  } catch {
    return false
  }
}

export function logCloudSyncRc(event: string, details?: Record<string, unknown>): void {
  if (!isCloudSyncRcLogEnabled()) return
  if (details) {
    log.info(`[cloudSync] ${event}`, details)
    return
  }
  log.info(`[cloudSync] ${event}`)
}
