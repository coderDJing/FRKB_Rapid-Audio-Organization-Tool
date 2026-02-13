import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import { useMixtapeTimeline } from '@renderer/composables/mixtape/useMixtapeTimeline'
import type {
  MixtapeOpenPayload,
  MixtapeRawItem,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'

export const useMixtape = () => {
  const payload = ref<MixtapeOpenPayload>({})
  const tracks = ref<MixtapeTrack[]>([])
  const selectedTrackId = ref('')
  const runtime = useRuntimeStore()

  const outputPath = ref('')
  const outputFormat = ref<'wav' | 'mp3'>('wav')
  const outputFilename = ref(buildRecFilename())
  const outputDialogVisible = ref(false)

  const bpmAnalysisActive = ref(false)
  const bpmAnalysisFailed = ref(false)
  const bpmAnalysisFailedCount = ref(0)
  let bpmAnalysisToken = 0
  let lastBpmAnalysisKey = ''

  let playlistUpdateTimer: ReturnType<typeof setTimeout> | null = null

  const {
    clearTimelineLayoutCache,
    updateTimelineWidth,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    laneIndices,
    laneHeight,
    laneTracks,
    resolveTrackBlockStyle,
    resolveTrackTitle,
    formatTrackBpm,
    isRawWaveformLoading,
    preRenderState,
    preRenderPercent,
    timelineScrollWrapRef,
    isTimelinePanning,
    handleTimelinePanStart,
    timelineScrollRef,
    timelineScrollbarOptions,
    timelineViewport,
    timelineContentWidth,
    timelineScrollLeft,
    timelineViewportWidth,
    timelineCanvasRef,
    overviewRef,
    isOverviewDragging,
    handleOverviewMouseDown,
    handleOverviewClick,
    resolveOverviewTrackStyle,
    overviewViewportStyle
  } = useMixtapeTimeline({ tracks, bpmAnalysisActive, bpmAnalysisFailed })

  const displayName = computed(() => {
    return (
      payload.value.playlistName ||
      payload.value.playlistPath ||
      payload.value.playlistId ||
      t('mixtape.playlistUnknown')
    )
  })

  const titleLabel = computed(() => {
    return `FRKB - ${t('mixtape.title')} - ${displayName.value}`
  })

  const mixtapeMenus = computed(() => [
    {
      name: 'mixtape.menu',
      subMenu: [[{ name: 'mixtape.menuOutput' }]]
    }
  ])

  const applyPayload = (next: MixtapeOpenPayload) => {
    payload.value = {
      ...payload.value,
      ...(next || {})
    }
  }

  const normalizeMixtapeFilePath = (value: unknown) => {
    if (typeof value !== 'string') return ''
    return value.trim()
  }

  const parseSnapshot = (raw: MixtapeRawItem, index: number): MixtapeTrack => {
    let info: Record<string, any> | null = null
    if (raw?.infoJson) {
      try {
        info = JSON.parse(String(raw.infoJson))
      } catch {
        info = null
      }
    }
    const filePath =
      normalizeMixtapeFilePath(raw?.filePath) || normalizeMixtapeFilePath(info?.filePath)
    const fileName = filePath.split(/[/\\]/).pop() || filePath || t('tracks.unknownTrack')
    return {
      id: String(raw?.id || `${filePath}-${index}`),
      mixOrder: Number(raw?.mixOrder) || index + 1,
      title: String(info?.title || fileName || t('tracks.unknownTrack')),
      artist: String(info?.artist || ''),
      duration: String(info?.duration || ''),
      filePath,
      originPath: String(raw?.originPathSnapshot || ''),
      originPlaylistUuid: raw?.originPlaylistUuid ? String(raw.originPlaylistUuid) : null,
      bpm: typeof info?.bpm === 'number' ? info.bpm : undefined
    }
  }

  const buildMixtapeBpmTargets = () => {
    const unique = new Set<string>()
    const targets: string[] = []
    for (const track of tracks.value) {
      const filePath = normalizeMixtapeFilePath(track.filePath)
      if (!filePath || unique.has(filePath)) continue
      unique.add(filePath)
      targets.push(filePath)
    }
    return targets
  }

  const requestMixtapeBpmAnalysis = async () => {
    const filePaths = buildMixtapeBpmTargets()
    if (!filePaths.length || !window?.electron?.ipcRenderer?.invoke) {
      bpmAnalysisActive.value = false
      return
    }
    const bpmTargets = new Set(filePaths)
    const missingPathCount = tracks.value.filter(
      (track) => !normalizeMixtapeFilePath(track.filePath)
    ).length
    if (missingPathCount > 0) {
      console.warn('[mixtape] BPM analyze skipped tracks without file path', { missingPathCount })
    }
    const key = [...filePaths].sort().join('|')
    const hasMissingBpm = tracks.value.some((track) => {
      const trackPath = normalizeMixtapeFilePath(track.filePath)
      if (!trackPath || !bpmTargets.has(trackPath)) return false
      return typeof track.bpm !== 'number' || !Number.isFinite(track.bpm) || track.bpm <= 0
    })
    if (key === lastBpmAnalysisKey && !hasMissingBpm) return

    const token = (bpmAnalysisToken += 1)
    let allResolved = false
    bpmAnalysisActive.value = true
    bpmAnalysisFailed.value = false
    bpmAnalysisFailedCount.value = 0

    scheduleTimelineDraw()
    try {
      const result = await window.electron.ipcRenderer.invoke('mixtape:analyze-bpm', { filePaths })
      if (token !== bpmAnalysisToken) return
      const results = Array.isArray(result?.results) ? result.results : []
      const unresolved = Array.isArray(result?.unresolved) ? result.unresolved : []
      const unresolvedDetails = Array.isArray(result?.unresolvedDetails)
        ? result.unresolvedDetails
        : []
      if (unresolvedDetails.length > 0) {
        console.warn('[mixtape] BPM analyze unresolved details', {
          count: unresolvedDetails.length,
          sample: unresolvedDetails.slice(0, 5)
        })
      }
      if (results.length > 0) {
        const bpmMap = new Map<string, number>()
        for (const item of results) {
          const filePath = normalizeMixtapeFilePath(item?.filePath)
          const bpmValue = item?.bpm
          if (!filePath || typeof bpmValue !== 'number' || !Number.isFinite(bpmValue)) continue
          bpmMap.set(filePath, bpmValue)
        }
        if (bpmMap.size > 0) {
          tracks.value = tracks.value.map((track) => {
            const trackPath = normalizeMixtapeFilePath(track.filePath)
            const bpmValue = trackPath ? bpmMap.get(trackPath) : undefined
            if (bpmValue === undefined || bpmValue === track.bpm) return track
            return { ...track, bpm: bpmValue }
          })
          clearTimelineLayoutCache()
          updateTimelineWidth(false)
          scheduleTimelineDraw()
          scheduleFullPreRender()
          scheduleWorkerPreRender()
        }
        const missingTrackCount = tracks.value.filter((track) => {
          const trackPath = normalizeMixtapeFilePath(track.filePath)
          if (!trackPath || !bpmTargets.has(trackPath)) return false
          return typeof track.bpm !== 'number' || !Number.isFinite(track.bpm) || track.bpm <= 0
        }).length
        if (missingTrackCount > 0) {
          bpmAnalysisFailed.value = true
          bpmAnalysisFailedCount.value = Math.max(
            missingTrackCount,
            unresolvedDetails.length,
            unresolved.length,
            Math.max(0, filePaths.length - bpmMap.size)
          )
        } else {
          allResolved = true
        }
      } else if (filePaths.length > 0) {
        bpmAnalysisFailed.value = true
        bpmAnalysisFailedCount.value = Math.max(unresolved.length, filePaths.length)
      }
    } catch (error) {
      bpmAnalysisFailed.value = true
      bpmAnalysisFailedCount.value = Math.max(filePaths.length, 1)
      console.error('[mixtape] BPM analyze invoke failed', {
        fileCount: filePaths.length,
        error
      })
    } finally {
      if (token === bpmAnalysisToken) {
        if (allResolved) {
          lastBpmAnalysisKey = key
        } else if (lastBpmAnalysisKey === key) {
          lastBpmAnalysisKey = ''
        }
        bpmAnalysisActive.value = false
        scheduleTimelineDraw()
      }
    }
  }

  const loadMixtapeItems = async () => {
    if (!payload.value.playlistId) {
      tracks.value = []
      selectedTrackId.value = ''
      bpmAnalysisActive.value = false
      bpmAnalysisFailed.value = false
      bpmAnalysisFailedCount.value = 0
      lastBpmAnalysisKey = ''
      return
    }
    const result = await window.electron.ipcRenderer.invoke('mixtape:list', {
      playlistId: payload.value.playlistId
    })
    const rawItems = Array.isArray(result?.items) ? result.items : []
    tracks.value = rawItems.map((item: MixtapeRawItem, index: number) => parseSnapshot(item, index))
    if (!tracks.value.some((track) => track.id === selectedTrackId.value)) {
      selectedTrackId.value = tracks.value[0]?.id || ''
    }
    void requestMixtapeBpmAnalysis()
  }

  const openOutputDialog = () => {
    outputDialogVisible.value = true
  }

  const handleOutputDialogConfirm = (payload: {
    outputPath: string
    outputFormat: 'wav' | 'mp3'
    outputFilename: string
  }) => {
    outputPath.value = payload.outputPath
    outputFormat.value = payload.outputFormat
    outputFilename.value = payload.outputFilename
    outputDialogVisible.value = false
  }

  const handleOutputDialogCancel = () => {
    outputDialogVisible.value = false
  }

  const schedulePlaylistReload = () => {
    if (playlistUpdateTimer) {
      clearTimeout(playlistUpdateTimer)
    }
    playlistUpdateTimer = setTimeout(() => {
      playlistUpdateTimer = null
      loadMixtapeItems()
    }, 120)
  }

  const handlePlaylistContentChanged = (eventPayload: any) => {
    const playlistId = payload.value.playlistId
    if (!playlistId) return
    const uuids: string[] = Array.isArray(eventPayload?.uuids)
      ? eventPayload.uuids.filter(Boolean)
      : []
    if (!uuids.includes(playlistId)) return
    schedulePlaylistReload()
  }

  const handleOpen = (_e: any, next: MixtapeOpenPayload) => {
    if (!next || typeof next !== 'object') return
    applyPayload(next)
    loadMixtapeItems()
  }

  const handleTitleOpenDialog = (key: string) => {
    if (!key) return
    if (key === 'mixtape.menuOutput') {
      openOutputDialog()
      return
    }
    if (key === 'menu.exit') {
      window.electron.ipcRenderer.send('toggle-close')
      window.electron.ipcRenderer.send('mixtapeWindow-toggle-close')
      return
    }
    window.electron.ipcRenderer.send('mixtapeWindow-open-dialog', key)
  }

  watch(
    () => payload.value.playlistId,
    () => {
      loadMixtapeItems()
    },
    { immediate: true }
  )

  onMounted(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const playlistId = params.get('playlistId')
      const playlistPath = params.get('playlistPath')
      const playlistName = params.get('playlistName')
      applyPayload({
        playlistId: playlistId || undefined,
        playlistPath: playlistPath ? decodeURIComponent(playlistPath) : undefined,
        playlistName: playlistName ? decodeURIComponent(playlistName) : undefined
      })
    } catch {}
    window.electron.ipcRenderer.on('mixtape-open', handleOpen)
    window.electron.ipcRenderer.on('mixtapeWindow-max', (_e, next: boolean) => {
      runtime.isWindowMaximized = !!next
    })
    emitter.on('playlistContentChanged', handlePlaylistContentChanged)
  })

  onBeforeUnmount(() => {
    try {
      window.electron.ipcRenderer.removeListener('mixtape-open', handleOpen)
    } catch {}
    try {
      window.electron.ipcRenderer.removeAllListeners('mixtapeWindow-max')
    } catch {}
    try {
      emitter.off('playlistContentChanged', handlePlaylistContentChanged)
    } catch {}
    if (playlistUpdateTimer) {
      clearTimeout(playlistUpdateTimer)
      playlistUpdateTimer = null
    }
  })

  function buildRecFilename() {
    const now = new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return `rec-${date}-${time}`
  }

  return {
    t,
    titleLabel,
    mixtapeMenus,
    handleTitleOpenDialog,
    tracks,
    laneIndices,
    laneHeight,
    laneTracks,
    resolveTrackBlockStyle,
    resolveTrackTitle,
    formatTrackBpm,
    isRawWaveformLoading,
    preRenderState,
    preRenderPercent,
    timelineScrollWrapRef,
    isTimelinePanning,
    handleTimelinePanStart,
    timelineScrollRef,
    timelineScrollbarOptions,
    timelineViewport,
    timelineContentWidth,
    timelineScrollLeft,
    timelineViewportWidth,
    timelineCanvasRef,
    overviewRef,
    isOverviewDragging,
    handleOverviewMouseDown,
    handleOverviewClick,
    resolveOverviewTrackStyle,
    overviewViewportStyle,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    bpmAnalysisFailedCount,
    outputDialogVisible,
    outputPath,
    outputFormat,
    outputFilename,
    handleOutputDialogConfirm,
    handleOutputDialogCancel
  }
}
