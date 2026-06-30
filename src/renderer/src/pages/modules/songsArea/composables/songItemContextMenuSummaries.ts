import { t } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'

/**
 * 回收站删除 / 还原操作的结果汇总弹窗。
 * 从 useSongItemContextMenu 抽出：仅依赖 confirm / t，对外按需弹出汇总提示。
 */

export const showDeleteSummaryIfNeeded = async (
  summary: {
    total?: number
    success?: number
    failed?: number
  },
  options?: {
    restoredFailed?: boolean
  }
) => {
  const total = Number(summary?.total || 0)
  const success = Number(summary?.success || 0)
  const failed = Number(summary?.failed || 0)
  if (total <= 1 && failed === 0) return
  const content: string[] = []
  content.push(t('recycleBin.deleteSummarySuccess', { count: success }))
  if (failed > 0) {
    content.push(t('recycleBin.deleteSummaryFailed', { count: failed }))
    if (options?.restoredFailed) {
      content.push(t('recycleBin.deleteSummaryRestoredFailed', { count: failed }))
    }
  }
  await confirm({
    title: t('recycleBin.deleteSummaryTitle'),
    content,
    confirmShow: false
  })
}

export const showRestoreSummaryIfNeeded = async (summary: {
  total?: number
  restored?: number
  missingPlaylist?: number
  missingFile?: number
  missingRecord?: number
  failed?: number
}) => {
  const total = Number(summary?.total || 0)
  const restored = Number(summary?.restored || 0)
  const missingPlaylist = Number(summary?.missingPlaylist || 0)
  const missingFile = Number(summary?.missingFile || 0)
  const missingRecord = Number(summary?.missingRecord || 0)
  const failed = Number(summary?.failed || 0)
  if (
    total <= 1 &&
    missingPlaylist === 0 &&
    missingFile === 0 &&
    missingRecord === 0 &&
    failed === 0
  )
    return
  const content: string[] = []
  content.push(t('recycleBin.restoreSummarySuccess', { count: restored }))
  if (missingPlaylist > 0) {
    content.push(t('recycleBin.restoreSummaryMissingPlaylist', { count: missingPlaylist }))
    content.push(t('recycleBin.restoreMissingPlaylistHint'))
  }
  if (missingFile > 0) {
    content.push(t('recycleBin.restoreSummaryMissingFile', { count: missingFile }))
  }
  if (missingRecord > 0) {
    content.push(t('recycleBin.restoreSummaryMissingRecord', { count: missingRecord }))
  }
  if (failed > 0) {
    content.push(t('recycleBin.restoreSummaryFailed', { count: failed }))
  }
  await confirm({
    title: t('recycleBin.restoreSummaryTitle'),
    content,
    confirmShow: false
  })
}
