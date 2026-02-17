import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import { useMixtapeTimeline } from '@renderer/composables/mixtape/useMixtapeTimeline'
import { getKeyDisplayText as formatKeyDisplayText } from '@shared/keyDisplay'
import type {
  MixtapeOpenPayload,
  MixtapeRawItem,
  MixtapeTrack,
  TimelineTrackLayout
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
  const trackContextMenuVisible = ref(false)
  const trackContextMenuX = ref(0)
  const trackContextMenuY = ref(0)
  const trackContextTrackId = ref('')
  const beatAlignDialogVisible = ref(false)
  const beatAlignTrackId = ref('')

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
    handleTrackDragStart,
    transportPlaying,
    transportDecoding,
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadPercent,
    playheadVisible,
    playheadTimeLabel,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    overviewPlayheadStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    handleTransportToggle,
    handleTransportPlayFromStart,
    handleTransportStop,
    handleRulerSeek,
    transportError,
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

  const trackContextMenuStyle = computed(() => ({
    left: `${trackContextMenuX.value}px`,
    top: `${trackContextMenuY.value}px`
  }))

  const beatAlignTrack = computed(() => {
    const trackId = beatAlignTrackId.value
    if (!trackId) return null
    return tracks.value.find((track) => track.id === trackId) || null
  })

  const trackContextTrack = computed(() => {
    const trackId = trackContextTrackId.value
    if (!trackId) return null
    return tracks.value.find((track) => track.id === trackId) || null
  })

  const trackMenuMasterTempoChecked = computed(() => trackContextTrack.value?.masterTempo !== false)

  const formatTrackKey = (value?: string) => {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) return ''
    if (raw.toLowerCase() === 'o') return '-'
    const style = (runtime.setting as any).keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
    return formatKeyDisplayText(raw, style)
  }

  const formatTrackOriginalMeta = (track?: MixtapeTrack | null) => {
    if (!track) return ''
    const originalBpm = Number(track.originalBpm)
    const originalBpmText =
      Number.isFinite(originalBpm) && originalBpm > 0 ? formatTrackBpm(originalBpm) : ''
    const originalKeyText = formatTrackKey(track.originalKey || track.key)
    if (originalBpmText && originalKeyText) {
      return t('mixtape.originalMetaBoth', { bpm: originalBpmText, key: originalKeyText })
    }
    if (originalBpmText) {
      return t('mixtape.originalMetaBpmOnly', { bpm: originalBpmText })
    }
    if (originalKeyText) {
      return t('mixtape.originalMetaKeyOnly', { key: originalKeyText })
    }
    return ''
  }

  const resolveTrackTitleWithOriginalMeta = (track: MixtapeTrack) => {
    const baseTitle = resolveTrackTitle(track)
    const originalMeta = formatTrackOriginalMeta(track)
    if (!originalMeta) return baseTitle
    return `${baseTitle}（${originalMeta}）`
  }

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

  const normalizeBarBeatOffset = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return 0
    const rounded = Math.round(numeric)
    return ((rounded % 32) + 32) % 32
  }

  const normalizeFirstBeatMs = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric < 0) return 0
    return numeric
  }

  const normalizeBpm = (value: unknown) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return null
    return Number(numeric.toFixed(2))
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
    const parsedBpm =
      typeof info?.bpm === 'number' && Number.isFinite(info.bpm) && info.bpm > 0
        ? info.bpm
        : undefined
    const parsedOriginalBpmCandidate = Number(info?.originalBpm)
    const parsedOriginalBpm =
      Number.isFinite(parsedOriginalBpmCandidate) && parsedOriginalBpmCandidate > 0
        ? parsedOriginalBpmCandidate
        : parsedBpm
    const hasFirstBeatField = !!info && Object.prototype.hasOwnProperty.call(info, 'firstBeatMs')
    const parsedFirstBeatMsValue = Number(info?.firstBeatMs)
    const parsedFirstBeatMs =
      hasFirstBeatField && Number.isFinite(parsedFirstBeatMsValue) && parsedFirstBeatMsValue >= 0
        ? parsedFirstBeatMsValue
        : undefined
    const parsedKey = typeof info?.key === 'string' ? info.key.trim() : ''
    const parsedOriginalKeyRaw =
      typeof info?.originalKey === 'string' ? info.originalKey.trim() : ''
    const parsedOriginalKey = parsedOriginalKeyRaw || parsedKey || undefined
    const parsedBarBeatOffset = normalizeBarBeatOffset(info?.barBeatOffset)
    return {
      id: String(raw?.id || `${filePath}-${index}`),
      mixOrder: Number(raw?.mixOrder) || index + 1,
      title: String(info?.title || fileName || t('tracks.unknownTrack')),
      artist: String(info?.artist || ''),
      duration: String(info?.duration || ''),
      filePath,
      originPath: String(raw?.originPathSnapshot || ''),
      originPlaylistUuid: raw?.originPlaylistUuid ? String(raw.originPlaylistUuid) : null,
      key: parsedKey || undefined,
      originalKey: parsedOriginalKey,
      bpm: parsedBpm,
      originalBpm: parsedOriginalBpm,
      masterTempo: true,
      startSec: undefined,
      firstBeatMs: parsedFirstBeatMs,
      barBeatOffset: parsedBarBeatOffset
    }
  }

  const buildMixtapeBpmTargets = () => {
    const unique = new Set<string>()
    const targets: string[] = []
    for (const track of tracks.value) {
      const filePath = normalizeMixtapeFilePath(track.filePath)
      if (!filePath || unique.has(filePath)) continue
      const bpmValue = Number(track.bpm)
      const firstBeatMsValue = Number(track.firstBeatMs)
      const hasValidBpm = Number.isFinite(bpmValue) && bpmValue > 0
      const hasValidFirstBeatMs = Number.isFinite(firstBeatMsValue) && firstBeatMsValue >= 0
      if (hasValidBpm && hasValidFirstBeatMs) continue
      unique.add(filePath)
      targets.push(filePath)
    }
    return targets
  }

  const resolveMissingBpmTrackCount = (bpmTargets: Set<string>) => {
    if (!bpmTargets.size) return 0
    return tracks.value.filter((track) => {
      const trackPath = normalizeMixtapeFilePath(track.filePath)
      if (!trackPath || !bpmTargets.has(trackPath)) return false
      const bpmValue = Number(track.bpm)
      const firstBeatMsValue = Number(track.firstBeatMs)
      const missingBpm = !Number.isFinite(bpmValue) || bpmValue <= 0
      const missingFirstBeat = !Number.isFinite(firstBeatMsValue) || firstBeatMsValue < 0
      return missingBpm || missingFirstBeat
    }).length
  }

  const applyBpmResultsToTracks = (results: unknown[]) => {
    const analysisMap = new Map<string, { bpm: number; firstBeatMs: number }>()
    for (const item of results) {
      const filePath = normalizeMixtapeFilePath((item as any)?.filePath)
      const bpmValue = (item as any)?.bpm
      if (
        !filePath ||
        typeof bpmValue !== 'number' ||
        !Number.isFinite(bpmValue) ||
        bpmValue <= 0
      ) {
        continue
      }
      const rawFirstBeatMs = Number((item as any)?.firstBeatMs)
      const firstBeatMs =
        Number.isFinite(rawFirstBeatMs) && rawFirstBeatMs >= 0 ? rawFirstBeatMs : 0
      analysisMap.set(filePath, {
        bpm: bpmValue,
        firstBeatMs
      })
    }
    if (analysisMap.size === 0) return { resolvedCount: 0, changedCount: 0 }

    let changedCount = 0
    tracks.value = tracks.value.map((track) => {
      const trackPath = normalizeMixtapeFilePath(track.filePath)
      const trackAnalysis = trackPath ? analysisMap.get(trackPath) : undefined
      if (!trackAnalysis) return track
      const currentBpm = Number(track.bpm)
      const hasCurrentFirstBeatMs =
        typeof track.firstBeatMs === 'number' &&
        Number.isFinite(track.firstBeatMs) &&
        track.firstBeatMs >= 0
      const currentFirstBeatMs = hasCurrentFirstBeatMs ? Number(track.firstBeatMs) : 0
      const bpmChanged =
        !Number.isFinite(currentBpm) || Math.abs(trackAnalysis.bpm - currentBpm) > 0.0001
      const firstBeatChanged =
        !hasCurrentFirstBeatMs || Math.abs(trackAnalysis.firstBeatMs - currentFirstBeatMs) > 0.001
      if (!bpmChanged && !firstBeatChanged) return track
      changedCount += 1
      return {
        ...track,
        bpm: trackAnalysis.bpm,
        originalBpm:
          Number.isFinite(Number(track.originalBpm)) && Number(track.originalBpm) > 0
            ? track.originalBpm
            : trackAnalysis.bpm,
        masterTempo: track.masterTempo !== false,
        firstBeatMs: trackAnalysis.firstBeatMs
      }
    })

    if (changedCount > 0) {
      clearTimelineLayoutCache()
      updateTimelineWidth(false)
      scheduleTimelineDraw()
      scheduleFullPreRender()
      scheduleWorkerPreRender()
    }
    return { resolvedCount: analysisMap.size, changedCount }
  }

  const handleBpmBatchReady = (_e: unknown, payload: any) => {
    const results = Array.isArray(payload?.results) ? payload.results : []
    if (!results.length) return
    const { resolvedCount } = applyBpmResultsToTracks(results)
    if (resolvedCount <= 0) return
    const filePaths = buildMixtapeBpmTargets()
    const bpmTargets = new Set(filePaths)
    const missingTrackCount = resolveMissingBpmTrackCount(bpmTargets)
    if (missingTrackCount === 0) {
      if (bpmAnalysisActive.value) {
        bpmAnalysisToken += 1
      }
      lastBpmAnalysisKey = [...filePaths].sort().join('|')
      bpmAnalysisActive.value = false
      bpmAnalysisFailed.value = false
      bpmAnalysisFailedCount.value = 0
    } else if (bpmAnalysisFailed.value) {
      bpmAnalysisFailedCount.value = missingTrackCount
    }
    scheduleTimelineDraw()
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
    const missingTrackCount = resolveMissingBpmTrackCount(bpmTargets)
    const hasMissingBpm = missingTrackCount > 0
    if (!hasMissingBpm) {
      lastBpmAnalysisKey = key
      bpmAnalysisActive.value = false
      bpmAnalysisFailed.value = false
      bpmAnalysisFailedCount.value = 0
      scheduleTimelineDraw()
      return
    }

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
        const { resolvedCount } = applyBpmResultsToTracks(results)
        const remainMissingCount = resolveMissingBpmTrackCount(bpmTargets)
        if (remainMissingCount > 0) {
          bpmAnalysisFailed.value = true
          bpmAnalysisFailedCount.value = Math.max(
            remainMissingCount,
            unresolvedDetails.length,
            unresolved.length,
            Math.max(0, filePaths.length - resolvedCount)
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
    if (!tracks.value.some((track) => track.id === beatAlignTrackId.value)) {
      beatAlignDialogVisible.value = false
      beatAlignTrackId.value = ''
    }
    closeTrackContextMenu()
    void requestMixtapeBpmAnalysis()
  }

  const closeTrackContextMenu = () => {
    trackContextMenuVisible.value = false
    trackContextTrackId.value = ''
  }

  const openBeatAlignDialog = (trackId: string) => {
    const found = tracks.value.find((track) => track.id === trackId)
    if (!found) return
    beatAlignTrackId.value = trackId
    beatAlignDialogVisible.value = true
  }

  const handleTrackContextMenu = (item: TimelineTrackLayout, event: MouseEvent) => {
    const trackId = item?.track?.id || ''
    if (!trackId) return
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = 150
    const menuHeight = 70
    const safeX = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, event.clientX))
    const safeY = Math.max(8, Math.min(window.innerHeight - menuHeight - 8, event.clientY))
    trackContextMenuX.value = safeX
    trackContextMenuY.value = safeY
    trackContextTrackId.value = trackId
    trackContextMenuVisible.value = true
  }

  const handleTrackMenuAdjustGrid = () => {
    const trackId = trackContextTrackId.value
    closeTrackContextMenu()
    if (!trackId) return
    openBeatAlignDialog(trackId)
  }

  const handleTrackMenuToggleMasterTempo = () => {
    const trackId = trackContextTrackId.value
    if (!trackId) return
    const targetIndex = tracks.value.findIndex((track) => track.id === trackId)
    if (targetIndex < 0) return
    const currentTrack = tracks.value[targetIndex]
    if (!currentTrack) return
    const nextTracks = [...tracks.value]
    nextTracks.splice(targetIndex, 1, {
      ...currentTrack,
      masterTempo: currentTrack.masterTempo === false
    })
    tracks.value = nextTracks
    closeTrackContextMenu()
    scheduleTimelineDraw()
  }

  const handleBeatAlignDialogCancel = () => {
    beatAlignDialogVisible.value = false
    beatAlignTrackId.value = ''
  }

  const handleBeatAlignGridDefinitionSave = (payload: {
    barBeatOffset: number
    firstBeatMs: number
    bpm: number
  }) => {
    const trackId = beatAlignTrackId.value
    if (!trackId) return
    const targetIndex = tracks.value.findIndex((track) => track.id === trackId)
    if (targetIndex < 0) return
    const currentTrack = tracks.value[targetIndex]
    if (!currentTrack) return
    const normalizedOffset = normalizeBarBeatOffset(payload?.barBeatOffset)
    const normalizedFirstBeatMs = normalizeFirstBeatMs(payload?.firstBeatMs)
    const normalizedInputBpm = normalizeBpm(payload?.bpm)
    const currentOffset = normalizeBarBeatOffset(currentTrack.barBeatOffset)
    const currentFirstBeatMs = normalizeFirstBeatMs(currentTrack.firstBeatMs)
    const offsetChanged = normalizedOffset !== currentOffset
    const firstBeatChanged = Math.abs(normalizedFirstBeatMs - currentFirstBeatMs) > 0.0001
    const targetFilePath = normalizeMixtapeFilePath(currentTrack.filePath)
    const originalBpm = normalizeBpm(currentTrack.originalBpm)
    const bpmCompareBase = originalBpm ?? normalizeBpm(currentTrack.bpm)
    const shouldPersistBpm =
      normalizedInputBpm !== null &&
      (bpmCompareBase === null || Math.abs(normalizedInputBpm - bpmCompareBase) > 0.0001)
    const isSameTrack = (track: MixtapeTrack) =>
      targetFilePath.length > 0
        ? normalizeMixtapeFilePath(track.filePath) === targetFilePath
        : track.id === trackId
    const bpmChanged =
      shouldPersistBpm &&
      tracks.value.some((track) => {
        if (!isSameTrack(track)) return false
        const trackBpm = normalizeBpm(track.bpm)
        if (trackBpm === null) return true
        return Math.abs(trackBpm - Number(normalizedInputBpm)) > 0.0001
      })
    if (!offsetChanged && !firstBeatChanged && !bpmChanged) return
    const nextTracks = tracks.value.map((track) => {
      if (!isSameTrack(track)) return track
      return {
        ...track,
        barBeatOffset: normalizedOffset,
        firstBeatMs: normalizedFirstBeatMs,
        bpm:
          shouldPersistBpm && normalizedInputBpm !== null ? Number(normalizedInputBpm) : track.bpm
      }
    })
    tracks.value = nextTracks
    scheduleTimelineDraw()
    scheduleFullPreRender()
    scheduleWorkerPreRender()
    if (!targetFilePath || !window?.electron?.ipcRenderer?.invoke) return
    void window.electron.ipcRenderer
      .invoke('mixtape:update-grid-definition', {
        filePath: targetFilePath,
        barBeatOffset: normalizedOffset,
        firstBeatMs: normalizedFirstBeatMs,
        bpm: bpmChanged ? normalizedInputBpm : undefined
      })
      .catch((error) => {
        console.error('[mixtape] update grid definition failed', {
          filePath: targetFilePath,
          barBeatOffset: normalizedOffset,
          firstBeatMs: normalizedFirstBeatMs,
          bpm: bpmChanged ? normalizedInputBpm : undefined,
          error
        })
      })
  }

  const handleGlobalPointerDown = (event: PointerEvent) => {
    if (!trackContextMenuVisible.value) return
    const target = event.target as HTMLElement | null
    if (target?.closest('.mixtape-track-menu')) return
    closeTrackContextMenu()
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
    window.electron.ipcRenderer.on('mixtape-bpm-batch-ready', handleBpmBatchReady)
    window.electron.ipcRenderer.on('mixtapeWindow-max', (_e, next: boolean) => {
      runtime.isWindowMaximized = !!next
    })
    emitter.on('playlistContentChanged', handlePlaylistContentChanged)
    window.addEventListener('pointerdown', handleGlobalPointerDown, true)
  })

  onBeforeUnmount(() => {
    try {
      window.electron.ipcRenderer.removeListener('mixtape-open', handleOpen)
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener('mixtape-bpm-batch-ready', handleBpmBatchReady)
    } catch {}
    try {
      window.electron.ipcRenderer.removeAllListeners('mixtapeWindow-max')
    } catch {}
    try {
      emitter.off('playlistContentChanged', handlePlaylistContentChanged)
    } catch {}
    try {
      window.removeEventListener('pointerdown', handleGlobalPointerDown, true)
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
    resolveTrackTitleWithOriginalMeta,
    formatTrackBpm,
    formatTrackKey,
    formatTrackOriginalMeta,
    isRawWaveformLoading,
    preRenderState,
    preRenderPercent,
    handleTrackDragStart,
    handleTrackContextMenu,
    trackContextMenuVisible,
    trackContextMenuStyle,
    handleTrackMenuAdjustGrid,
    handleTrackMenuToggleMasterTempo,
    trackMenuMasterTempoChecked,
    beatAlignDialogVisible,
    beatAlignTrack,
    handleBeatAlignDialogCancel,
    handleBeatAlignGridDefinitionSave,
    transportPlaying,
    transportDecoding,
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadPercent,
    playheadVisible,
    playheadTimeLabel,
    timelineDurationLabel,
    rulerMinuteTicks,
    rulerInactiveStyle,
    overviewPlayheadStyle,
    rulerPlayheadStyle,
    timelinePlayheadStyle,
    handleTransportToggle,
    handleTransportPlayFromStart,
    handleTransportStop,
    handleRulerSeek,
    transportError,
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
