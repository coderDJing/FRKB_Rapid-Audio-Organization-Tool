import type { Ref } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { CONTACT_EMAIL } from '@renderer/constants/app'
import type {
  CloudSyncErrorPayload,
  CloudSyncNoticePayload,
  CloudSyncProgressPayload,
  CloudSyncState,
  CloudSyncSummary
} from 'src/types/cloudSync'

type RuntimeStore = ReturnType<typeof import('@renderer/stores/runtime').useRuntimeStore>

/**
 * 主窗口云同步相关的 IPC 事件处理（状态/进度/汇总/通知/错误）。
 * 从 App.vue 抽出，依赖通过参数注入，保持原有职责与行为不变。
 */
export function useCloudSyncEvents(options: { runtime: RuntimeStore; activeDialog: Ref<string> }) {
  const { runtime, activeDialog } = options

  const handleCloudSyncState = (_e: unknown, state: CloudSyncState) => {
    if (state === 'syncing') {
      if (!runtime.cloudSync.syncing) {
        runtime.setCloudSyncProgress('idle', 0, {})
      }
      runtime.setCloudSyncSyncing(true)
      return
    }
    if (state === 'success' || state === 'failed' || state === 'cancelled') {
      runtime.setCloudSyncSyncing(false)
      runtime.setCloudSyncMinimized(false)
      if (state !== 'success') {
        // 失败/取消：复位进度并收起底部进度行
        runtime.setCloudSyncProgress('idle', 0, {})
      } else if (!runtime.cloudSync.summaryVisible) {
        // 已是最新时不会弹汇总窗，成功态自己清掉进度残留
        runtime.setCloudSyncProgress('idle', 0, {})
      }
    }
  }

  const handleCloudSyncProgress = (_e: unknown, p: CloudSyncProgressPayload) => {
    runtime.setCloudSyncProgress(p.phase, p.percent, p.details || {})
  }

  const handleCloudSyncSummary = (_e: unknown, s: CloudSyncSummary) => {
    // summary 在 state:'success' 之前到达，这里负责收起同步窗、停 syncing、收起底部行并弹报告
    if (activeDialog.value === 'cloudSync.syncFingerprints') activeDialog.value = ''
    runtime.setCloudSyncSyncing(false)
    runtime.setCloudSyncMinimized(false)
    runtime.openCloudSyncSummary(s)
  }

  // 出错/通知时若云同步对话框仍打开，先关闭它再弹全局提示
  const closeCloudSyncDialogIfOpen = () => {
    if (activeDialog.value === 'cloudSync.syncFingerprints') activeDialog.value = ''
    runtime.setCloudSyncMinimized(false)
  }

  let isCloudSyncNoticePromptOpen = false
  const handleCloudSyncNotice = async (_e: unknown, payload: CloudSyncNoticePayload | null) => {
    if (isCloudSyncNoticePromptOpen) return
    let contentMsg = ''
    if (payload?.code === 'rate_limit_warning') {
      const retryAfterMs = Math.max(
        0,
        Number(payload?.retryAfterMs || payload?.details?.retryAfterMs || 0)
      )
      const seconds = Math.ceil(retryAfterMs / 1000)
      const currentInWindow = Number(payload?.currentInWindow || 0)
      if (currentInWindow === 8) {
        contentMsg = t('cloudSync.errors.rateLimitWarning8', { seconds })
      } else if (currentInWindow === 9) {
        contentMsg = t('cloudSync.errors.rateLimitWarning9', { seconds })
      } else {
        contentMsg = t('cloudSync.errors.rateLimit', { seconds })
      }
    } else {
      const msg = payload?.message || ''
      if (!msg) return
      contentMsg = t(msg)
    }
    // 限流警告：保留底部进度行（同步通常仍在后台继续），仅弹一次提示
    isCloudSyncNoticePromptOpen = true
    try {
      await confirm({ title: t('dialog.hint'), content: [contentMsg], confirmShow: false })
    } finally {
      isCloudSyncNoticePromptOpen = false
    }
  }

  let isCloudSyncErrorPromptOpen = false
  const handleCloudSyncError = async (_e: unknown, err: CloudSyncErrorPayload | null) => {
    // 网络错误或其他错误：复位状态并收起底部行，关闭对话框后提示
    runtime.setCloudSyncSyncing(false)
    runtime.setCloudSyncProgress('idle', 0, {})
    closeCloudSyncDialogIfOpen()
    if (isCloudSyncErrorPromptOpen) return
    isCloudSyncErrorPromptOpen = true
    try {
      const code = (err?.error?.code || err?.error?.error || '').toString().toUpperCase()
      if (code === 'RATE_LIMITED' && err?.error?.scope === 'sync_start') {
        const message = t('cloudSync.errors.sensitiveOperationTooFrequent')
        await confirm({ title: t('dialog.hint'), content: [message], confirmShow: false })
        return
      }
      if (code === 'FINGERPRINT_LIMIT_EXCEEDED') {
        const details = err?.error?.details || {}
        const limitNum = Number(details?.limit)
        const baseMsg = t('cloudSync.errors.limit.willExceedHint')
        const phase = String(details?.phase || '')
        let summaryLine = ''
        if (phase === 'check') {
          summaryLine = t('cloudSync.errors.limit.summary.check', {
            limit: Number.isFinite(limitNum) ? limitNum : '-',
            client: Number(details?.clientCount) || '-',
            server: Number(details?.serverCount) || '-'
          })
        } else if (phase === 'bidirectional_diff') {
          summaryLine = t('cloudSync.errors.limit.summary.bidirectional', {
            limit: Number.isFinite(limitNum) ? limitNum : '-',
            current: Number(details?.currentServerCount) || '-',
            add: Number(details?.requestedAddCount) || '-',
            allowed: Number(details?.allowedAddCount) || '-'
          })
        } else if (phase === 'analyze_diff') {
          summaryLine = t('cloudSync.errors.limit.summary.analyze', {
            limit: Number.isFinite(limitNum) ? limitNum : '-',
            final: Number(details?.finalTotal) || '-'
          })
        } else if (phase === 'batch_add') {
          summaryLine = t('cloudSync.errors.limit.summary.batchAdd', {
            limit: Number.isFinite(limitNum) ? limitNum : '-',
            current: Number(details?.currentCount) || '-',
            add: Number(details?.uniqueNewCount) || '-',
            allowed: Number(details?.allowedAddCount) || '-'
          })
        } else {
          summaryLine = t('cloudSync.errors.limit.summary.batchAdd', {
            limit: Number.isFinite(limitNum) ? limitNum : '-',
            current: Number(details?.currentServerCount || details?.currentCount) || '-',
            add: Number(details?.requestedAddCount || details?.uniqueNewCount) || '-',
            allowed: Number(details?.allowedAddCount) || '-'
          })
        }
        const lines = [
          baseMsg,
          summaryLine || t('cloudSync.errors.limit.willExceedHint'),
          t('cloudSync.errors.limit.contactToIncreaseLimit', { email: CONTACT_EMAIL })
        ]
        await confirm({ title: t('common.error'), content: lines, confirmShow: false })
        return
      }
      const logMsg = t(err?.message || 'error')
      await confirm({ title: t('common.error'), content: [logMsg], confirmShow: false })
    } finally {
      isCloudSyncErrorPromptOpen = false
    }
  }

  return {
    handleCloudSyncState,
    handleCloudSyncProgress,
    handleCloudSyncSummary,
    handleCloudSyncNotice,
    handleCloudSyncError
  }
}
