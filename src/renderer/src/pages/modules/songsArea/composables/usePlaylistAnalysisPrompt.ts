import { computed, onMounted, onUnmounted, ref, type Ref } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import {
  collectMissingAnalysisFilesFromSongs,
  queueManualKeyAnalysisBatch
} from '@renderer/utils/manualKeyAnalysis'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import { RECORDING_LIBRARY_UUID } from '@shared/recordingLibrary'
import type { ISongInfo } from '../../../../../../types/globals'

type PlaylistAnalysisRuntime = {
  libraryAreaSelected: string
  analysisRuntime: {
    available: boolean
  }
  playlistAnalysisPromptDismissedSongListUUIDs: string[]
}

type SongsAreaAnalysisState = {
  songListUUID: string
  songInfoArr: ISongInfo[]
}

type QueueManualBatchResult = {
  batchId?: string
  queued?: number
}

type ManualBatchEndPayload = {
  batchId?: string
  filePaths?: string[]
  canceled?: boolean
}

type OpenSongListAnalysisPromptOptions = {
  forceAnalysisPrompt?: boolean
}

export function usePlaylistAnalysisPrompt({
  runtime,
  songsAreaState,
  isMixtapeListView
}: {
  runtime: PlaylistAnalysisRuntime
  songsAreaState: SongsAreaAnalysisState
  isMixtapeListView: Ref<boolean>
}) {
  const autoAnalyzeEnabled = ref(false)
  const manualAnalyzePending = ref(false)
  const promptOwnedManualBatchSongListUUIDs = new Map<string, string>()
  const songListAutoAnalyzeEnabled = computed(() =>
    isMixtapeListView.value ? true : autoAnalyzeEnabled.value
  )
  const missingAnalysisFiles = computed(() =>
    collectMissingAnalysisFilesFromSongs(
      songsAreaState.songInfoArr,
      runtime.analysisRuntime.available === true
    )
  )

  const shouldSkipAnalysisPrompt = (songListUUID: string) =>
    !songListUUID ||
    songListUUID === EXTERNAL_PLAYLIST_UUID ||
    songListUUID === RECYCLE_BIN_UUID ||
    songListUUID === RECORDING_LIBRARY_UUID ||
    runtime.libraryAreaSelected === 'RecordingLibrary' ||
    isMixtapeListView.value

  const clearDismissedSongList = (songListUUID: string) => {
    runtime.playlistAnalysisPromptDismissedSongListUUIDs =
      runtime.playlistAnalysisPromptDismissedSongListUUIDs.filter((uuid) => uuid !== songListUUID)
  }

  const isDismissedSongList = (songListUUID: string) =>
    runtime.playlistAnalysisPromptDismissedSongListUUIDs.includes(songListUUID)

  const markDismissedSongList = (songListUUID: string) => {
    if (isDismissedSongList(songListUUID)) return
    runtime.playlistAnalysisPromptDismissedSongListUUIDs = [
      ...runtime.playlistAnalysisPromptDismissedSongListUUIDs,
      songListUUID
    ]
  }

  const rememberManualBatch = (result: QueueManualBatchResult, songListUUID: string) => {
    const batchId = String(result?.batchId || '').trim()
    if (!batchId || !songListUUID) return
    promptOwnedManualBatchSongListUUIDs.set(batchId, songListUUID)
  }

  const handleManualBatchEnd = (_event: unknown, payload?: ManualBatchEndPayload) => {
    const batchId = String(payload?.batchId || '').trim()
    if (!batchId) return
    const songListUUID = promptOwnedManualBatchSongListUUIDs.get(batchId)
    if (!songListUUID) return
    promptOwnedManualBatchSongListUUIDs.delete(batchId)
    if (!payload?.canceled) return
    if (songsAreaState.songListUUID !== songListUUID) return
    autoAnalyzeEnabled.value = false
    if (missingAnalysisFiles.value.length) markDismissedSongList(songListUUID)
  }

  onMounted(() => {
    window.electron.ipcRenderer.on('key-analysis:manual-batch-end', handleManualBatchEnd)
  })

  onUnmounted(() => {
    promptOwnedManualBatchSongListUUIDs.clear()
    window.electron.ipcRenderer.removeListener(
      'key-analysis:manual-batch-end',
      handleManualBatchEnd
    )
  })

  const handleUserOpenedSongList = async (
    songListUUID: string,
    options?: OpenSongListAnalysisPromptOptions
  ) => {
    autoAnalyzeEnabled.value = false
    if (shouldSkipAnalysisPrompt(songListUUID)) return

    const missingCount = missingAnalysisFiles.value.length
    if (!missingCount) {
      clearDismissedSongList(songListUUID)
      return
    }
    if (options?.forceAnalysisPrompt) {
      clearDismissedSongList(songListUUID)
    } else if (isDismissedSongList(songListUUID)) {
      return
    }

    const choice = await confirm({
      title: t('tracks.analyzePlaylistPromptTitle'),
      content: [
        t('tracks.analyzePlaylistPromptContent', { count: missingCount }),
        t('tracks.analyzePlaylistPromptQuestion')
      ],
      confirmText: t('tracks.analyzePlaylistConfirm'),
      cancelText: t('tracks.analyzePlaylistCancel')
    })

    if (songsAreaState.songListUUID !== songListUUID) return
    if (choice !== 'confirm') {
      const stillMissingFiles = missingAnalysisFiles.value
      if (stillMissingFiles.length) markDismissedSongList(songListUUID)
      return
    }

    const missingFiles = missingAnalysisFiles.value
    if (!missingFiles.length) return

    clearDismissedSongList(songListUUID)
    autoAnalyzeEnabled.value = true
    const result = (await queueManualKeyAnalysisBatch(
      missingFiles,
      'tracks.analyzingPlaylist'
    )) as QueueManualBatchResult
    rememberManualBatch(result, songListUUID)
  }

  const playlistAnalysisActionVisible = computed(
    () =>
      !manualAnalyzePending.value &&
      !shouldSkipAnalysisPrompt(songsAreaState.songListUUID) &&
      isDismissedSongList(songsAreaState.songListUUID) &&
      missingAnalysisFiles.value.length > 0
  )

  const analyzeDismissedPlaylist = async () => {
    const songListUUID = songsAreaState.songListUUID
    const missingFiles = missingAnalysisFiles.value
    if (
      manualAnalyzePending.value ||
      shouldSkipAnalysisPrompt(songListUUID) ||
      !isDismissedSongList(songListUUID) ||
      !missingFiles.length
    ) {
      return
    }

    manualAnalyzePending.value = true
    autoAnalyzeEnabled.value = true
    clearDismissedSongList(songListUUID)
    try {
      const result = (await queueManualKeyAnalysisBatch(
        missingFiles,
        'tracks.analyzingPlaylist'
      )) as QueueManualBatchResult
      rememberManualBatch(result, songListUUID)
    } catch (error) {
      autoAnalyzeEnabled.value = false
      markDismissedSongList(songListUUID)
      console.error('queue playlist analysis failed', error)
    } finally {
      manualAnalyzePending.value = false
    }
  }

  return {
    songListAutoAnalyzeEnabled,
    playlistAnalysisActionVisible,
    playlistAnalysisActionPending: manualAnalyzePending,
    handleUserOpenedSongList,
    analyzeDismissedPlaylist
  }
}
