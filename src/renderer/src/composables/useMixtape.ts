import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import emitter from '@renderer/utils/mitt'
import confirmDialog from '@renderer/components/confirmDialog'
import { useMixtapeTimeline } from '@renderer/composables/mixtape/useMixtapeTimeline'
import { createMixtapeAutoGainController } from '@renderer/composables/mixtape/autoGainController'
import {
  MIXTAPE_ENVELOPE_PARAMS,
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
  buildFlatMixEnvelope,
  normalizeMixEnvelopePoints
} from '@renderer/composables/mixtape/gainEnvelope'
import {
  normalizeBpm,
  normalizeBarBeatOffset,
  normalizeFirstBeatMs,
  normalizeMixtapeFilePath,
  normalizeUniquePaths,
  parseSnapshot
} from '@renderer/composables/mixtape/mixtapeTrackSnapshot'
import {
  applyBpmResultsToTracks,
  buildMixtapeBpmTargetKey,
  buildMixtapeBpmTargets,
  resolveMissingBpmTrackCount
} from '@renderer/composables/mixtape/mixtapeBpmAnalysis'
import {
  buildRecFilename,
  resolveMixtapeOutputProgressState
} from '@renderer/composables/mixtape/mixtapeOutputProgress'
import { createMixtapeMissingTracksNotifier } from '@renderer/composables/mixtape/mixtapeMissingTracksNotifier'
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
  const mixtapeRawItems = ref<MixtapeRawItem[]>([])
  const selectedTrackId = ref('')
  const runtime = useRuntimeStore()

  const outputPath = ref('')
  const outputFormat = ref<'wav' | 'mp3'>('wav')
  const outputFilename = ref(buildRecFilename())
  const outputDialogVisible = ref(false)
  const outputRunning = ref(false)
  const outputProgressKey = ref('mixtape.outputProgressPreparing')
  const outputProgressPercent = ref(0)
  const outputProgressDone = ref(0)
  const outputProgressTotal = ref(100)
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
  const { notifyMissingTracksRemoved } = createMixtapeMissingTracksNotifier()

  const {
    clearTimelineLayoutCache,
    updateTimelineWidth,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    renderZoomLevel,
    resolveTrackDurationSeconds,
    resolveTrackFirstBeatSeconds,
    laneIndices,
    laneHeight,
    laneTracks,
    resolveTrackBlockStyle,
    resolveGainEnvelopePolyline,
    resolveTrackTitle,
    formatTrackBpm,
    isRawWaveformLoading,
    preRenderState,
    preRenderPercent,
    timelineRootRef,
    rulerRef,
    timelineVisualScale,
    handleTrackDragStart,
    transportPlaying,
    transportDecoding,
    transportPreloading,
    transportPreloadDone,
    transportPreloadTotal,
    transportPreloadPercent,
    playheadVisible,
    followPlayheadEnabled,
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
    handleToggleFollowPlayhead,
    transportError,
    renderMixtapeOutputWav,
    timelineScrollWrapRef,
    isTimelinePanning,
    handleTimelinePanStart,
    handleTimelineHorizontalPanStart,
    timelineScrollRef,
    timelineScrollbarOptions,
    timelineViewport,
    timelineContentWidth,
    timelineScrollLeft,
    timelineViewportWidth,
    timelineCanvasRef,
    envelopePreviewRef,
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

  const mixtapePlaylistId = computed(() => String(payload.value.playlistId || ''))

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
  const outputProgressText = computed(() => {
    const stageKey = outputProgressKey.value || 'mixtape.outputProgressPreparing'
    const stageLabel = t(stageKey as any)
    const percent = Math.max(0, Math.min(100, Number(outputProgressPercent.value) || 0))
    const done = Math.max(0, Number(outputProgressDone.value) || 0)
    const total = Math.max(0, Number(outputProgressTotal.value) || 0)
    if (total > 0 && done <= total) {
      return `${stageLabel} ${done}/${total} (${percent}%)`
    }
    return `${stageLabel} (${percent}%)`
  })

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
      name: 'mixtape.menuOutput',
      subMenu: [],
      directAction: 'mixtape.menuOutput',
      disabled: outputRunning.value
    }
  ])

  const applyPayload = (next: MixtapeOpenPayload) => {
    payload.value = {
      ...payload.value,
      ...(next || {})
    }
  }

  const buildBpmTargets = () => buildMixtapeBpmTargets(tracks.value)

  const resolveMissingBpmCount = (bpmTargets: Set<string>) =>
    resolveMissingBpmTrackCount(tracks.value, bpmTargets)

  const applyBpmAnalysisToTracks = (results: unknown[]) => {
    const applied = applyBpmResultsToTracks(tracks.value, results)
    if (applied.resolvedCount <= 0) return applied
    tracks.value = applied.nextTracks
    if (applied.changedCount > 0) {
      clearTimelineLayoutCache()
      updateTimelineWidth(false)
      scheduleTimelineDraw()
      scheduleFullPreRender()
      scheduleWorkerPreRender()
    }
    return applied
  }

  const handleBpmBatchReady = (_e: unknown, payload: any) => {
    const results = Array.isArray(payload?.results) ? payload.results : []
    if (!results.length) return
    const { resolvedCount } = applyBpmAnalysisToTracks(results)
    if (resolvedCount <= 0) return
    const filePaths = buildBpmTargets()
    const bpmTargets = new Set(filePaths)
    const missingTrackCount = resolveMissingBpmCount(bpmTargets)
    if (missingTrackCount === 0) {
      if (bpmAnalysisActive.value) {
        bpmAnalysisToken += 1
      }
      lastBpmAnalysisKey = buildMixtapeBpmTargetKey(filePaths)
      bpmAnalysisActive.value = false
      bpmAnalysisFailed.value = false
      bpmAnalysisFailedCount.value = 0
    } else if (bpmAnalysisFailed.value) {
      bpmAnalysisFailedCount.value = missingTrackCount
    }
    scheduleTimelineDraw()
  }

  const requestMixtapeBpmAnalysis = async () => {
    const filePaths = buildBpmTargets()
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
    const key = buildMixtapeBpmTargetKey(filePaths)
    const missingTrackCount = resolveMissingBpmCount(bpmTargets)
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
        const { resolvedCount } = applyBpmAnalysisToTracks(results)
        const remainMissingCount = resolveMissingBpmCount(bpmTargets)
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
      mixtapeRawItems.value = []
      tracks.value = []
      selectedTrackId.value = ''
      resetAutoGainState()
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
    mixtapeRawItems.value = rawItems
    const removedPaths = Array.isArray(result?.recovery?.removedPaths)
      ? normalizeUniquePaths(result.recovery.removedPaths)
      : []
    tracks.value = rawItems.map((item: MixtapeRawItem, index: number) =>
      parseSnapshot(item, index, t('tracks.unknownTrack'))
    )
    if (!tracks.value.some((track) => track.id === selectedTrackId.value)) {
      selectedTrackId.value = tracks.value[0]?.id || ''
    }
    syncAutoGainReferenceTrack()
    if (!tracks.value.some((track) => track.id === beatAlignTrackId.value)) {
      beatAlignDialogVisible.value = false
      beatAlignTrackId.value = ''
    }
    closeTrackContextMenu()
    if (removedPaths.length > 0) {
      void notifyMissingTracksRemoved(payload.value.playlistId || '', removedPaths)
    }
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
    const nextMasterTempo = currentTrack.masterTempo === false
    const nextTracks = [...tracks.value]
    nextTracks.splice(targetIndex, 1, {
      ...currentTrack,
      masterTempo: nextMasterTempo
    })
    tracks.value = nextTracks
    if (window?.electron?.ipcRenderer?.invoke) {
      void window.electron.ipcRenderer
        .invoke('mixtape:update-track-start-sec', {
          entries: [
            {
              itemId: currentTrack.id,
              masterTempo: nextMasterTempo
            }
          ]
        })
        .catch((error) => {
          console.error('[mixtape] update master tempo failed', {
            itemId: currentTrack.id,
            masterTempo: nextMasterTempo,
            error
          })
        })
    }
    closeTrackContextMenu()
    scheduleTimelineDraw()
  }

  const handleBeatAlignDialogCancel = () => {
    beatAlignDialogVisible.value = false
    beatAlignTrackId.value = ''
  }

  const handleBeatAlignGridDefinitionSave = async (payload: {
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
    const gridBaseBpm = normalizeBpm(currentTrack.gridBaseBpm)
    const originalBpm = normalizeBpm(currentTrack.originalBpm)
    const bpmCompareBase = gridBaseBpm ?? originalBpm ?? normalizeBpm(currentTrack.bpm)
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
        const trackBpmBase =
          normalizeBpm(track.gridBaseBpm) ??
          normalizeBpm(track.originalBpm) ??
          normalizeBpm(track.bpm)
        if (trackBpmBase === null) return true
        return Math.abs(trackBpmBase - Number(normalizedInputBpm)) > 0.0001
      })
    if (!offsetChanged && !firstBeatChanged && !bpmChanged) return
    const gridPositionChanged = firstBeatChanged || bpmChanged
    const shouldResetEnvelope = gridPositionChanged
      ? (await confirmDialog({
          title: t('mixtape.gridAdjustSaveResetEnvelopeTitle'),
          content: [t('mixtape.gridAdjustSaveResetEnvelopeHint')],
          confirmText: t('mixtape.gridAdjustSaveResetEnvelopeConfirm'),
          cancelText: t('mixtape.gridAdjustSaveResetEnvelopeCancel')
        })) === 'confirm'
      : false
    if (gridPositionChanged && !shouldResetEnvelope) return
    const nextTracks = tracks.value.map((track) => {
      if (!isSameTrack(track)) return track
      const fallbackGridBaseBpm =
        normalizeBpm(track.gridBaseBpm) ?? normalizeBpm(track.originalBpm) ?? track.gridBaseBpm
      const nextTrack = {
        ...track,
        barBeatOffset: normalizedOffset,
        firstBeatMs: normalizedFirstBeatMs,
        gridBaseBpm:
          shouldPersistBpm && normalizedInputBpm !== null
            ? Number(normalizedInputBpm)
            : fallbackGridBaseBpm,
        bpm:
          shouldPersistBpm && normalizedInputBpm !== null ? Number(normalizedInputBpm) : track.bpm
      }
      if (!shouldResetEnvelope) return nextTrack
      for (const param of MIXTAPE_ENVELOPE_PARAMS) {
        const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
        ;(nextTrack as any)[envelopeField] = buildFlatMixEnvelope(
          param,
          resolveTrackDurationSeconds(track),
          1
        )
      }
      nextTrack.volumeMuteSegments = []
      return nextTrack
    })
    tracks.value = nextTracks
    scheduleTimelineDraw()
    scheduleFullPreRender()
    scheduleWorkerPreRender()
    if (!window?.electron?.ipcRenderer?.invoke) return

    if (targetFilePath) {
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

    if (!shouldResetEnvelope) return
    const affectedTracks = nextTracks.filter((track) => isSameTrack(track))
    if (!affectedTracks.length) return
    const envelopeUpdateTasks = MIXTAPE_ENVELOPE_PARAMS.map((param) => {
      const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
      const entries = affectedTracks
        .map((track) => {
          const points = normalizeMixEnvelopePoints(
            param,
            (track as any)?.[envelopeField],
            resolveTrackDurationSeconds(track)
          )
          if (points.length < 2) return null
          return {
            itemId: track.id,
            gainEnvelope: points.map((point) => ({
              sec: Number(point.sec),
              gain: Number(point.gain)
            }))
          }
        })
        .filter(
          (item): item is { itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> } =>
            item !== null
        )
      if (!entries.length) return Promise.resolve(null)
      return window.electron.ipcRenderer.invoke('mixtape:update-mix-envelope', {
        param,
        entries
      })
    })
    const muteSegmentUpdateEntries = affectedTracks.map((track) => ({
      itemId: track.id,
      segments: []
    }))
    const muteSegmentUpdateTask =
      muteSegmentUpdateEntries.length > 0
        ? window.electron.ipcRenderer.invoke('mixtape:update-volume-mute-segments', {
            entries: muteSegmentUpdateEntries
          })
        : Promise.resolve(null)
    void Promise.all([...envelopeUpdateTasks, muteSegmentUpdateTask]).catch((error) => {
      console.error('[mixtape] reset mix envelope after grid update failed', {
        trackCount: affectedTracks.length,
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

  const isEditableEventTarget = (target: EventTarget | null) => {
    const element = target as HTMLElement | null
    if (!element) return false
    if (element.isContentEditable) return true
    const tag = element.tagName?.toLowerCase() || ''
    return tag === 'input' || tag === 'textarea' || tag === 'select'
  }

  const handleWindowKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (event.isComposing) return
    if (event.code !== 'Space' && event.key !== ' ') return
    if (event.repeat) {
      event.preventDefault()
      return
    }
    if (isEditableEventTarget(event.target)) return
    if (
      beatAlignDialogVisible.value ||
      outputDialogVisible.value ||
      outputRunning.value ||
      autoGainDialogVisible.value
    )
      return

    event.preventDefault()
    if (transportPlaying.value || transportDecoding.value) {
      handleTransportStop()
      return
    }
    handleTransportPlayFromStart()
  }

  const openOutputDialog = () => {
    if (outputRunning.value) return
    outputDialogVisible.value = true
  }

  const applyOutputProgressPayload = (payload: any) => {
    const nextState = resolveMixtapeOutputProgressState(
      {
        stageKey: outputProgressKey.value,
        done: outputProgressDone.value,
        total: outputProgressTotal.value,
        percent: outputProgressPercent.value
      },
      payload
    )
    outputProgressKey.value = nextState.stageKey
    outputProgressDone.value = nextState.done
    outputProgressTotal.value = nextState.total
    outputProgressPercent.value = nextState.percent
  }

  const runMixtapeOutput = async () => {
    if (outputRunning.value) return
    const normalizedOutputPath = outputPath.value.trim()
    const normalizedFilename = outputFilename.value.trim()
    if (!normalizedOutputPath) {
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.outputPathRequired')],
        confirmShow: false
      })
      return
    }
    if (!normalizedFilename) {
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.outputFilenameRequired')],
        confirmShow: false
      })
      return
    }
    if (!tracks.value.length) {
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.outputNoTracks')],
        confirmShow: false
      })
      return
    }

    outputRunning.value = true
    outputProgressKey.value = 'mixtape.outputProgressPreparing'
    outputProgressDone.value = 0
    outputProgressTotal.value = 100
    outputProgressPercent.value = 0
    await nextTick()
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

    const payload = {
      outputPath: normalizedOutputPath,
      outputFormat: outputFormat.value,
      outputFilename: normalizedFilename
    }

    try {
      const rendered = await renderMixtapeOutputWav({
        onProgress: applyOutputProgressPayload
      })
      const result = await window.electron.ipcRenderer.invoke('mixtape:output', {
        ...payload,
        wavBytes: rendered.wavBytes,
        durationSec: rendered.durationSec,
        sampleRate: rendered.sampleRate,
        channels: rendered.channels
      })
      if (!result?.ok) {
        throw new Error(result?.error || t('common.unknownError'))
      }
      applyOutputProgressPayload({
        stageKey: 'mixtape.outputProgressFinished',
        done: 100,
        total: 100,
        percent: 100
      })
      outputRunning.value = false
      await confirmDialog({
        title: t('common.finished'),
        content: [t('mixtape.outputFinishedHint', { path: String(result?.outputPath || '') })],
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 500
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || t('common.error'))
      applyOutputProgressPayload({
        stageKey: 'mixtape.outputProgressFailed',
        done: 100,
        total: 100,
        percent: 100
      })
      outputRunning.value = false
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.outputFailedHint', { reason: message })],
        confirmShow: false,
        textAlign: 'left',
        innerWidth: 500
      })
    } finally {
      outputRunning.value = false
    }
  }

  const handleOutputDialogConfirm = async (payload: {
    outputPath: string
    outputFormat: 'wav' | 'mp3'
    outputFilename: string
  }) => {
    outputPath.value = payload.outputPath
    outputFormat.value = payload.outputFormat
    outputFilename.value = payload.outputFilename
    outputDialogVisible.value = false
    await runMixtapeOutput()
  }

  const handleOutputDialogCancel = () => {
    outputDialogVisible.value = false
  }

  const persistGainEnvelope = async (
    entries: Array<{ itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> }>
  ) => {
    if (!entries.length || !window?.electron?.ipcRenderer?.invoke) return
    try {
      await window.electron.ipcRenderer.invoke('mixtape:update-gain-envelope', { entries })
    } catch (error) {
      console.error('[mixtape] update gain envelope failed', {
        count: entries.length,
        error
      })
    }
  }

  const showAutoGainErrorDialog = async (message: string) => {
    await confirmDialog({
      title: t('common.error'),
      content: [message],
      confirmShow: false
    })
  }

  const {
    autoGainDialogVisible,
    autoGainReferenceTrackId,
    autoGainReferenceFeedback,
    autoGainBusy,
    autoGainReferenceOptions,
    autoGainProgressText,
    canStartAutoGain,
    openAutoGainDialog,
    handleAutoGainDialogCancel,
    handleAutoGainDialogConfirm,
    handleAutoGainSelectLoudestReference,
    handleAutoGainSelectQuietestReference,
    syncReferenceTrack: syncAutoGainReferenceTrack,
    resetAutoGainState
  } = createMixtapeAutoGainController({
    tracks,
    selectedTrackId,
    transportPlaying,
    transportDecoding,
    bpmAnalysisActive,
    resolveTrackTitle,
    t,
    onStopTransport: handleTransportStop,
    onEnvelopeApplied: () => {
      clearTimelineLayoutCache()
      updateTimelineWidth(false)
      scheduleTimelineDraw()
    },
    persistGainEnvelope,
    showErrorDialog: showAutoGainErrorDialog
  })

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

  const handleMixtapeOutputProgress = (_e: unknown, payload: any) => {
    applyOutputProgressPayload(payload)
  }

  const handleTitleOpenDialog = (key: string) => {
    if (!key) return
    if (key === 'mixtape.menuOutput') {
      if (outputRunning.value) return
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
    window.electron.ipcRenderer.on('mixtape-output:progress', handleMixtapeOutputProgress)
    window.electron.ipcRenderer.on('mixtapeWindow-max', (_e, next: boolean) => {
      runtime.isWindowMaximized = !!next
    })
    emitter.on('playlistContentChanged', handlePlaylistContentChanged)
    window.addEventListener('pointerdown', handleGlobalPointerDown, true)
    window.addEventListener('keydown', handleWindowKeydown)
  })

  onBeforeUnmount(() => {
    try {
      window.electron.ipcRenderer.removeListener('mixtape-open', handleOpen)
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener('mixtape-bpm-batch-ready', handleBpmBatchReady)
    } catch {}
    try {
      window.electron.ipcRenderer.removeListener(
        'mixtape-output:progress',
        handleMixtapeOutputProgress
      )
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
    try {
      window.removeEventListener('keydown', handleWindowKeydown)
    } catch {}
    if (playlistUpdateTimer) {
      clearTimeout(playlistUpdateTimer)
      playlistUpdateTimer = null
    }
  })

  return {
    t,
    titleLabel,
    mixtapePlaylistId,
    mixtapeMenus,
    handleTitleOpenDialog,
    mixtapeRawItems,
    tracks,
    laneIndices,
    laneHeight,
    laneTracks,
    renderZoomLevel,
    resolveTrackDurationSeconds,
    resolveTrackFirstBeatSeconds,
    resolveTrackBlockStyle,
    resolveGainEnvelopePolyline,
    resolveTrackTitle,
    resolveTrackTitleWithOriginalMeta,
    formatTrackBpm,
    formatTrackKey,
    formatTrackOriginalMeta,
    isRawWaveformLoading,
    preRenderState,
    preRenderPercent,
    timelineRootRef,
    rulerRef,
    timelineVisualScale,
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
    followPlayheadEnabled,
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
    handleToggleFollowPlayhead,
    transportError,
    timelineScrollWrapRef,
    isTimelinePanning,
    handleTimelinePanStart,
    handleTimelineHorizontalPanStart,
    timelineScrollRef,
    timelineScrollbarOptions,
    timelineViewport,
    timelineContentWidth,
    timelineScrollLeft,
    timelineViewportWidth,
    timelineCanvasRef,
    envelopePreviewRef,
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
    outputRunning,
    outputProgressText,
    outputProgressPercent,
    handleOutputDialogConfirm,
    handleOutputDialogCancel,
    autoGainDialogVisible,
    autoGainReferenceTrackId,
    autoGainReferenceFeedback,
    autoGainReferenceOptions,
    autoGainBusy,
    autoGainProgressText,
    canStartAutoGain,
    openAutoGainDialog,
    handleAutoGainDialogCancel,
    handleAutoGainDialogConfirm,
    handleAutoGainSelectLoudestReference,
    handleAutoGainSelectQuietestReference
  }
}
