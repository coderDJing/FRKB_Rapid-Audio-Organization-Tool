import { nextTick } from 'vue'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import emitter from '@renderer/utils/mitt'
import { t } from '@renderer/utils/translate'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'

type DeleteSummary = {
  total?: number
  success?: number
  failed?: number
  removedPaths?: string[]
}

const normalizePath = (p: string | undefined | null) => (p || '').replace(/\//g, '\\').toLowerCase()

const normalizeDeleteSummary = (summary: unknown): DeleteSummary => {
  const payload = summary && typeof summary === 'object' ? (summary as DeleteSummary) : {}
  return {
    total: Number(payload.total || 0),
    success: Number(payload.success || 0),
    failed: Number(payload.failed || 0),
    removedPaths: Array.isArray(payload.removedPaths) ? payload.removedPaths : []
  }
}

const showDeleteSummaryIfNeeded = async (
  summary: {
    total?: number
    success?: number
    failed?: number
  },
  options?: {
    restoredFailed?: boolean
  }
) => {
  const success = Number(summary?.success || 0)
  const failed = Number(summary?.failed || 0)
  if (failed <= 0) return
  const content: string[] = []
  content.push(t('recycleBin.deleteSummarySuccess', { count: success }))
  content.push(t('recycleBin.deleteSummaryFailed', { count: failed }))
  if (options?.restoredFailed) {
    content.push(t('recycleBin.deleteSummaryRestoredFailed', { count: failed }))
  }
  await confirm({
    title: t('recycleBin.deleteSummaryTitle'),
    content,
    confirmShow: false
  })
}

const clearRecycleBinPlayback = (runtime: ReturnType<typeof useRuntimeStore>) => {
  if (runtime.playingData.playingSongListUUID !== RECYCLE_BIN_UUID) return
  try {
    emitter.emit('waveform-preview:stop', { reason: 'switch' })
  } catch {}
  runtime.playingData.playingSong = null
  runtime.playingData.playingSongListUUID = ''
  runtime.playingData.playingSongListData = []
}

const reloadRecycleBinSongsAreaIfNeeded = async (runtime: ReturnType<typeof useRuntimeStore>) => {
  if (runtime.songsArea.songListUUID !== RECYCLE_BIN_UUID) return
  runtime.songsArea.songListUUID = ''
  runtime.songsArea.selectedSongFilePath.length = 0
  await nextTick()
  runtime.songsArea.songListUUID = RECYCLE_BIN_UUID
}

export async function emptyRecycleBinWithOptimisticUpdate(
  runtime: ReturnType<typeof useRuntimeStore>
) {
  if (runtime.isProgressing) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }

  const res = await confirm({
    title: t('recycleBin.emptyRecycleBin'),
    content: [t('recycleBin.confirmEmpty'), t('tracks.deleteHint')]
  })
  if (res !== 'confirm') return

  const isRecycleBinView = runtime.songsArea.songListUUID === RECYCLE_BIN_UUID
  const optimisticPaths = isRecycleBinView
    ? Array.from(
        new Set(runtime.songsArea.songInfoArr.map((song) => song.filePath).filter(Boolean))
      )
    : []

  runtime.isProgressing = true
  try {
    if (optimisticPaths.length > 0) {
      emitter.emit('songsArea/optimistic-remove', {
        listUUID: RECYCLE_BIN_UUID,
        paths: optimisticPaths
      })
    }
    clearRecycleBinPlayback(runtime)

    const deleteSummary = normalizeDeleteSummary(
      await window.electron.ipcRenderer.invoke('emptyRecycleBin')
    )

    await reloadRecycleBinSongsAreaIfNeeded(runtime)

    try {
      emitter.emit('playlistContentChanged', { uuids: [RECYCLE_BIN_UUID] })
    } catch {}

    if (Number(deleteSummary.failed || 0) > 0) {
      const removedNormalizedSet = new Set(
        (deleteSummary.removedPaths || []).map((item) => normalizePath(item))
      )
      const restoredFailed = optimisticPaths.some(
        (item) => !removedNormalizedSet.has(normalizePath(item))
      )
      await showDeleteSummaryIfNeeded(deleteSummary, { restoredFailed })
    }
  } catch {
    await reloadRecycleBinSongsAreaIfNeeded(runtime)
    await confirm({
      title: t('common.error'),
      content: [t('recycleBin.progressFailed')],
      confirmShow: false
    })
  } finally {
    runtime.isProgressing = false
  }
}
