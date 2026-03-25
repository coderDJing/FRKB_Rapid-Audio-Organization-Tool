import { nextTick } from 'vue'
import { resolveContextMenuPoint } from '@renderer/utils/contextMenuPosition'
import { FIXED_MIXTAPE_STEM_MODE } from '@shared/mixtapeStemMode'
import {
  applyMixtapeGlobalTempoTargetsToTracks,
  buildFlatMixtapeGlobalBpmEnvelope,
  buildDefaultMixtapeGlobalBpmEnvelopeSnapshot,
  normalizeMixtapeGlobalBpmEnvelopePoints,
  resolveDefaultGlobalBpmFromTracks
} from '@renderer/composables/mixtape/mixtapeGlobalTempoModel'
import { createMixtapeMasterGrid } from '@renderer/composables/mixtape/mixtapeMasterGrid'
import {
  applyMixtapeGlobalTempoSnapshot,
  isMixtapeGlobalTempoReady,
  mixtapeGlobalTempoEnvelope,
  mixtapeGlobalTempoSource,
  resetMixtapeGlobalTempoState
} from '@renderer/composables/mixtape/mixtapeGlobalTempoState'
import { resolveBeatSecByBpm } from '@renderer/composables/mixtape/mixxxSyncModel'
import {
  BPM_POINT_SEC_EPSILON,
  resolveTrackGridSourceBpm,
  roundTrackTempoSec
} from '@renderer/composables/mixtape/trackTempoModel'

export const createUseMixtapeBpmAndUiModule = (ctx: any) => {
  const {
    payload,
    tracks,
    mixtapeRawItems,
    mixtapeItemsLoading,
    selectedTrackId,
    mixtapeMixMode,
    mixtapeStemMode,
    mixtapeStemProfile,
    outputDialogVisible,
    outputRunning,
    outputPath,
    outputFormat,
    outputFilename,
    outputProgressKey,
    outputProgressPercent,
    outputProgressDone,
    outputProgressTotal,
    trackContextMenuVisible,
    trackContextMenuX,
    trackContextMenuY,
    trackContextTrackId,
    beatAlignDialogVisible,
    beatAlignTrackId,
    bpmAnalysisActive,
    bpmAnalysisFailed,
    bpmAnalysisFailedCount,
    bpmAnalysisFailedReason,
    stemSummary,
    stemRuntimeProgressByTrackId,
    stemResumeBootstrappedPlaylistIdSet,
    stemResumeSignatureByPlaylistId,
    autoGainDialogVisible,
    transportPreloading,
    stemSeparationProgressVisible,
    stemRuntimeDownloadVisible,
    transportPlaying,
    transportDecoding,
    createEmptyStemSummary,
    applyBpmAnalysisToTracks,
    buildBpmTargets,
    resolveMissingBpmCount,
    buildMixtapeBpmTargetKey,
    scheduleTimelineDraw,
    scheduleFullPreRender,
    scheduleWorkerPreRender,
    clearTimelineLayoutCache,
    updateTimelineWidth,
    resolveTrackDurationSeconds,
    resolveTrackSourceDurationSeconds,
    resolveTrackFirstBeatSeconds,
    resolveTrackTitle,
    renderMixtapeOutputWav,
    normalizeMixtapeFilePath,
    normalizeMixtapeMixMode,
    normalizeMixtapeStemMode,
    normalizeStemProfile,
    normalizeMixtapeStemStatus,
    normalizeStemSummary,
    normalizeUniquePaths,
    parseSnapshot,
    hasTrackStemPathsReady,
    autoResumePendingStemJobs,
    pruneStemRuntimeProgressByTracks,
    resolveTrackStemModel,
    syncAutoGainReferenceTrack,
    resetAutoGainState,
    notifyMissingTracksRemoved,
    resolveMixtapeStemModelByProfile,
    resolveMixtapeOutputProgressState,
    normalizeBarBeatOffset,
    normalizeFirstBeatMs,
    normalizeBpm,
    MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL,
    MIXTAPE_ENVELOPE_PARAMS_STEM,
    MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
    buildFlatMixEnvelope,
    normalizeMixEnvelopePoints,
    DEFAULT_MIXTAPE_STEM_PROFILE,
    confirmDialog,
    t,
    handleTransportStop,
    handleTransportPlayFromStart
  } = ctx

  let bpmAnalysisToken = 0
  let lastBpmAnalysisKey = ''
  let mixtapeItemsRequestToken = 0

  const syncTracksWithGlobalTempo = () => {
    if (!isMixtapeGlobalTempoReady()) return
    tracks.value = applyMixtapeGlobalTempoTargetsToTracks(
      tracks.value,
      mixtapeGlobalTempoEnvelope.value
    )
  }

  const refreshTimelineForGlobalTempoChange = (options?: {
    redrawOnly?: boolean
    refreshWaveform?: boolean
  }) => {
    syncTracksWithGlobalTempo()
    clearTimelineLayoutCache()
    updateTimelineWidth(false)
    scheduleTimelineDraw()
    if (options?.redrawOnly) return
    if (options?.refreshWaveform !== false) {
      scheduleFullPreRender()
      scheduleWorkerPreRender()
    }
  }

  const ensureDefaultGlobalTempoEnvelope = (
    playlistId: string,
    options?: { refreshWaveform?: boolean }
  ) => {
    const normalizedPlaylistId = typeof playlistId === 'string' ? playlistId.trim() : ''
    if (!normalizedPlaylistId || !tracks.value.length) return
    if (
      mixtapeGlobalTempoSource.value === 'persisted' ||
      mixtapeGlobalTempoSource.value === 'user'
    ) {
      return
    }
    const nextSnapshot = buildDefaultMixtapeGlobalBpmEnvelopeSnapshot({
      tracks: tracks.value,
      resolveTrackDurationSeconds
    })
    applyMixtapeGlobalTempoSnapshot({
      playlistId: normalizedPlaylistId,
      snapshot: nextSnapshot,
      source: 'generated'
    })
    refreshTimelineForGlobalTempoChange({
      refreshWaveform: options?.refreshWaveform !== false
    })
  }

  const readNormalizedProjectGlobalTempoSnapshot = async (playlistId: string, trackList: any[]) => {
    const normalizedPlaylistId = typeof playlistId === 'string' ? playlistId.trim() : ''
    if (!normalizedPlaylistId || !window?.electron?.ipcRenderer?.invoke) {
      return null
    }
    try {
      const result = await window.electron.ipcRenderer.invoke('mixtape:project:get-bpm-envelope', {
        playlistId: normalizedPlaylistId
      })
      const defaultBpm = resolveDefaultGlobalBpmFromTracks(trackList)
      const normalizedSnapshot = {
        bpmEnvelope: normalizeMixtapeGlobalBpmEnvelopePoints(
          result?.bpmEnvelope,
          Number(result?.bpmEnvelopeDurationSec) || 0,
          defaultBpm
        ),
        bpmEnvelopeDurationSec: Math.max(0, Number(result?.bpmEnvelopeDurationSec) || 0)
      }
      if (
        normalizedSnapshot.bpmEnvelope.length >= 2 &&
        normalizedSnapshot.bpmEnvelopeDurationSec > 0
      ) {
        return normalizedSnapshot
      }
    } catch (error) {
      console.error('[mixtape] load project bpm envelope failed', {
        playlistId: normalizedPlaylistId,
        error
      })
    }
    return null
  }

  const materializeGridAlignedTrackStartSecs = (
    inputTracks: any[],
    globalPoints: Array<{ sec: number; bpm: number }>
  ) => {
    const GRID_ALIGN_BAR_INTERVAL = 32
    const fallbackBpm = resolveDefaultGlobalBpmFromTracks(inputTracks)
    const safePoints =
      Array.isArray(globalPoints) && globalPoints.length >= 2
        ? globalPoints
        : buildFlatMixtapeGlobalBpmEnvelope(0, fallbackBpm)
    const masterGrid = createMixtapeMasterGrid({
      points: safePoints,
      fallbackBpm
    })
    let cursorSec = 0
    const persistedEntries: Array<{ itemId: string; startSec: number }> = []
    const nextTracks = inputTracks.map((track: any) => {
      const rawStartSec = Number(track?.startSec)
      const hasExplicitStartSec = Number.isFinite(rawStartSec)
      const sourceDurationSec = Math.max(0, Number(resolveTrackSourceDurationSeconds(track)) || 0)
      const gridSourceBpm = resolveTrackGridSourceBpm(track)
      const beatSourceSec = Math.max(BPM_POINT_SEC_EPSILON, resolveBeatSecByBpm(gridSourceBpm))
      const currentBeatSec = Math.max(
        BPM_POINT_SEC_EPSILON,
        resolveBeatSecByBpm(Number(track?.bpm) || gridSourceBpm)
      )
      const firstBeatSourceSec = Math.max(0, Number(track?.firstBeatMs) || 0) / 1000
      const firstBeatSourceBeats = firstBeatSourceSec / beatSourceSec
      const sourceDurationBeats = sourceDurationSec / beatSourceSec
      const normalizedBarBeatOffset = normalizeBarBeatOffset(track?.barBeatOffset)
      const firstBarLineSourceBeats = firstBeatSourceBeats + normalizedBarBeatOffset
      const hasVisibleBarLine =
        firstBarLineSourceBeats <= sourceDurationBeats + BPM_POINT_SEC_EPSILON
      const sourceAnchorBeats = hasVisibleBarLine ? firstBarLineSourceBeats : firstBeatSourceBeats
      const anchorIntervalBeats = hasVisibleBarLine ? GRID_ALIGN_BAR_INTERVAL : 1
      const firstBeatLocalSec = Math.max(0, Number(resolveTrackFirstBeatSeconds(track)) || 0)
      const localAnchorSec = hasVisibleBarLine
        ? firstBeatLocalSec + normalizedBarBeatOffset * currentBeatSec
        : firstBeatLocalSec
      const shouldPlaceFirstAnchorAtTimelineZero = cursorSec <= BPM_POINT_SEC_EPSILON
      const nextGlobalAnchorIndex = shouldPlaceFirstAnchorAtTimelineZero
        ? 0
        : Math.floor(
            (masterGrid.mapSecToBeats(cursorSec) + BPM_POINT_SEC_EPSILON) / anchorIntervalBeats
          ) + 1
      const desiredAnchorBeat = nextGlobalAnchorIndex * anchorIntervalBeats
      const minimumAnchorBeat = shouldPlaceFirstAnchorAtTimelineZero
        ? 0
        : Math.max(anchorIntervalBeats, Math.ceil(sourceAnchorBeats - BPM_POINT_SEC_EPSILON))
      const startBeat = Math.max(
        0,
        Math.max(desiredAnchorBeat, minimumAnchorBeat) - sourceAnchorBeats
      )
      const generatedStartSec = shouldPlaceFirstAnchorAtTimelineZero
        ? roundTrackTempoSec(-localAnchorSec)
        : roundTrackTempoSec(masterGrid.mapBeatsToSec(startBeat))
      const startSec = hasExplicitStartSec ? roundTrackTempoSec(rawStartSec) : generatedStartSec
      const nextTrack = hasExplicitStartSec ? track : { ...track, startSec }
      const trackStartBeat = masterGrid.mapSecToBeats(startSec)
      const trackEndSec = roundTrackTempoSec(
        beatSourceSec > BPM_POINT_SEC_EPSILON
          ? masterGrid.mapBeatsToSec(trackStartBeat + sourceDurationBeats)
          : startSec + sourceDurationSec
      )
      cursorSec = Math.max(cursorSec, trackEndSec)
      if (!hasExplicitStartSec && nextTrack?.id) {
        persistedEntries.push({
          itemId: String(nextTrack.id),
          startSec
        })
      }
      return nextTrack
    })
    return {
      tracks: nextTracks,
      persistedEntries
    }
  }

  const normalizeBpmFailureReason = (value: unknown): string => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) return ''
    return text.length <= 240 ? text : `${text.slice(0, 240)}...`
  }

  const handleBpmBatchReady = (_e: unknown, eventPayload: any) => {
    const results = Array.isArray(eventPayload?.results) ? eventPayload.results : []
    if (!results.length) return
    const { resolvedCount } = applyBpmAnalysisToTracks(results)
    if (resolvedCount <= 0) return
    const playlistId = String(payload.value.playlistId || '').trim()
    if (playlistId) {
      ensureDefaultGlobalTempoEnvelope(playlistId)
    } else if (isMixtapeGlobalTempoReady()) {
      syncTracksWithGlobalTempo()
    }
    const filePaths = buildBpmTargets()
    const bpmTargets = new Set(filePaths)
    const missingTrackCount = resolveMissingBpmCount(bpmTargets)
    if (missingTrackCount === 0) {
      if (bpmAnalysisActive.value) {
        bpmAnalysisToken += 1
      }
      lastBpmAnalysisKey = buildMixtapeBpmTargetKey(filePaths)
      bpmAnalysisActive.value = false
      dismissBpmAnalysisFailure()
    } else if (bpmAnalysisFailed.value) {
      bpmAnalysisFailedCount.value = missingTrackCount
    }
    scheduleTimelineDraw()
  }

  const clearBpmAnalysisFailedTimer = () => {}

  const dismissBpmAnalysisFailure = () => {
    clearBpmAnalysisFailedTimer()
    bpmAnalysisFailed.value = false
    bpmAnalysisFailedCount.value = 0
    bpmAnalysisFailedReason.value = ''
  }

  const retryBpmAnalysis = () => {
    if (bpmAnalysisActive.value) return
    dismissBpmAnalysisFailure()
    void requestMixtapeBpmAnalysis()
  }

  const requestMixtapeBpmAnalysis = async () => {
    const filePaths = buildBpmTargets()
    if (!filePaths.length || !window?.electron?.ipcRenderer?.invoke) {
      bpmAnalysisActive.value = false
      dismissBpmAnalysisFailure()
      return
    }
    const bpmTargets = new Set(filePaths)
    const missingPathCount = tracks.value.filter(
      (track: any) => !normalizeMixtapeFilePath(track.filePath)
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
      dismissBpmAnalysisFailure()
      scheduleTimelineDraw()
      return
    }

    const token = (bpmAnalysisToken += 1)
    let allResolved = false
    clearBpmAnalysisFailedTimer()
    bpmAnalysisActive.value = true
    bpmAnalysisFailed.value = false
    bpmAnalysisFailedCount.value = 0
    bpmAnalysisFailedReason.value = ''

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
      const unresolvedReason = normalizeBpmFailureReason(unresolvedDetails[0]?.reason)
      if (results.length > 0) {
        const { resolvedCount } = applyBpmAnalysisToTracks(results)
        const remainMissingCount = resolveMissingBpmCount(bpmTargets)
        if (remainMissingCount > 0) {
          bpmAnalysisFailed.value = true
          bpmAnalysisFailedReason.value = unresolvedReason
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
        bpmAnalysisFailedReason.value = unresolvedReason
        bpmAnalysisFailedCount.value = Math.max(unresolved.length, filePaths.length)
      }
    } catch (error) {
      bpmAnalysisFailed.value = true
      bpmAnalysisFailedReason.value = normalizeBpmFailureReason(
        error instanceof Error ? error.message : String(error || '')
      )
      bpmAnalysisFailedCount.value = Math.max(filePaths.length, 1)
      console.error('[mixtape] BPM analyze invoke failed', {
        fileCount: filePaths.length,
        error
      })
    } finally {
      if (token === bpmAnalysisToken) {
        if (allResolved) {
          lastBpmAnalysisKey = key
          dismissBpmAnalysisFailure()
        } else if (lastBpmAnalysisKey === key) {
          lastBpmAnalysisKey = ''
        }
        bpmAnalysisActive.value = false
        scheduleTimelineDraw()
      }
    }
  }

  const loadMixtapeItems = async (options?: { background?: boolean }) => {
    const requestToken = ++mixtapeItemsRequestToken
    const playlistId = String(payload.value.playlistId || '').trim()
    if (!playlistId) {
      mixtapeItemsLoading.value = false
      mixtapeRawItems.value = []
      mixtapeMixMode.value = 'stem'
      mixtapeStemMode.value = FIXED_MIXTAPE_STEM_MODE
      mixtapeStemProfile.value = DEFAULT_MIXTAPE_STEM_PROFILE
      stemSummary.value = createEmptyStemSummary()
      stemRuntimeProgressByTrackId.value = {}
      tracks.value = []
      selectedTrackId.value = ''
      resetAutoGainState()
      bpmAnalysisActive.value = false
      dismissBpmAnalysisFailure()
      lastBpmAnalysisKey = ''
      resetMixtapeGlobalTempoState()
      return
    }
    const hasVisibleItems = tracks.value.length > 0 || mixtapeRawItems.value.length > 0
    const showLoading = !options?.background || !hasVisibleItems
    if (showLoading) {
      mixtapeItemsLoading.value = true
    }
    try {
      resetMixtapeGlobalTempoState(playlistId)
      const result = await window.electron.ipcRenderer.invoke('mixtape:list', {
        playlistId
      })
      if (requestToken !== mixtapeItemsRequestToken) return
      mixtapeMixMode.value = normalizeMixtapeMixMode(result?.mixMode)
      mixtapeStemMode.value = FIXED_MIXTAPE_STEM_MODE
      mixtapeStemProfile.value = normalizeStemProfile(
        result?.stemProfile,
        DEFAULT_MIXTAPE_STEM_PROFILE
      )
      stemSummary.value = normalizeStemSummary(result?.stemSummary)
      const rawItems = Array.isArray(result?.items) ? result.items : []
      mixtapeRawItems.value = rawItems
      const removedPaths = Array.isArray(result?.recovery?.removedPaths)
        ? normalizeUniquePaths(result.recovery.removedPaths)
        : []
      const parsedTracks = rawItems.map((item: any, index: number) =>
        parseSnapshot(item, index, t('tracks.unknownTrack'))
      )
      const persistedGlobalSnapshot = await readNormalizedProjectGlobalTempoSnapshot(
        playlistId,
        parsedTracks
      )
      const generatedGlobalSnapshot = buildDefaultMixtapeGlobalBpmEnvelopeSnapshot({
        tracks: parsedTracks,
        resolveTrackDurationSeconds
      })
      const defaultLayoutSnapshot = persistedGlobalSnapshot || generatedGlobalSnapshot
      const { tracks: hydratedTracks, persistedEntries } = materializeGridAlignedTrackStartSecs(
        parsedTracks,
        defaultLayoutSnapshot.bpmEnvelope
      )
      tracks.value = hydratedTracks
      if (persistedEntries.length > 0 && window?.electron?.ipcRenderer?.invoke) {
        void window.electron.ipcRenderer
          .invoke('mixtape:update-track-start-sec', {
            entries: persistedEntries
          })
          .catch((error: unknown) => {
            console.error('[mixtape] persist generated track start sec failed', {
              playlistId,
              count: persistedEntries.length,
              error
            })
          })
      }
      if (persistedGlobalSnapshot) {
        applyMixtapeGlobalTempoSnapshot({
          playlistId,
          snapshot: persistedGlobalSnapshot,
          source: 'persisted'
        })
        refreshTimelineForGlobalTempoChange()
      } else {
        ensureDefaultGlobalTempoEnvelope(playlistId)
      }
      pruneStemRuntimeProgressByTracks(tracks.value)
      const stemMode = FIXED_MIXTAPE_STEM_MODE
      const currentPlaylistId = playlistId

      if (mixtapeMixMode.value === 'stem') {
        const missingStemAssetReadyTracks = tracks.value.filter(
          (track: any) =>
            normalizeMixtapeStemStatus(track.stemStatus) === 'ready' &&
            !hasTrackStemPathsReady(track, stemMode)
        )
        if (missingStemAssetReadyTracks.length > 0 && window?.electron?.ipcRenderer?.invoke) {
          const repairFilePaths = Array.from(
            new Set(
              missingStemAssetReadyTracks
                .map((track: any) => normalizeMixtapeFilePath(track.filePath))
                .filter(Boolean)
            )
          )
          if (repairFilePaths.length > 0) {
            void window.electron.ipcRenderer
              .invoke('mixtape:stem:enqueue', {
                playlistId,
                filePaths: repairFilePaths,
                stemMode,
                profile: mixtapeStemProfile.value,
                force: false
              })
              .catch((error: unknown) => {
                console.error('[mixtape] stem path backfill enqueue failed', {
                  playlistId,
                  count: repairFilePaths.length,
                  error
                })
              })
          }
        }
        if (currentPlaylistId) {
          const includeRunning = !stemResumeBootstrappedPlaylistIdSet.has(currentPlaylistId)
          await autoResumePendingStemJobs({
            playlistId: currentPlaylistId,
            stemMode,
            trackList: tracks.value,
            includeRunning
          })
          if (requestToken !== mixtapeItemsRequestToken) return
          stemResumeBootstrappedPlaylistIdSet.add(currentPlaylistId)
        }
      } else if (currentPlaylistId) {
        stemResumeBootstrappedPlaylistIdSet.delete(currentPlaylistId)
        stemResumeSignatureByPlaylistId.delete(currentPlaylistId)
      }
      if (!tracks.value.some((track: any) => track.id === selectedTrackId.value)) {
        selectedTrackId.value = tracks.value[0]?.id || ''
      }
      syncAutoGainReferenceTrack()
      if (!tracks.value.some((track: any) => track.id === beatAlignTrackId.value)) {
        beatAlignDialogVisible.value = false
        beatAlignTrackId.value = ''
      }
      closeTrackContextMenu()
      if (removedPaths.length > 0) {
        void notifyMissingTracksRemoved(playlistId, removedPaths)
      }
      void requestMixtapeBpmAnalysis()
    } catch (error) {
      if (requestToken !== mixtapeItemsRequestToken) return
      console.error('[mixtape] load mixtape items failed', {
        playlistId,
        error
      })
    } finally {
      if (showLoading && requestToken === mixtapeItemsRequestToken) {
        mixtapeItemsLoading.value = false
      }
    }
  }

  const closeTrackContextMenu = () => {
    trackContextMenuVisible.value = false
    trackContextTrackId.value = ''
  }

  const openBeatAlignDialog = (trackId: string) => {
    const found = tracks.value.find((track: any) => track.id === trackId)
    if (!found) return
    beatAlignTrackId.value = trackId
    beatAlignDialogVisible.value = true
  }

  const handleTrackContextMenu = (item: any, event: MouseEvent) => {
    const trackId = item?.track?.id || ''
    if (!trackId) return
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = 190
    const menuHeight = 108
    const { x, y } = resolveContextMenuPoint(
      {
        clickX: event.clientX,
        clickY: event.clientY,
        menuWidth,
        menuHeight
      },
      { padding: 8 }
    )
    trackContextMenuX.value = x
    trackContextMenuY.value = y
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
    const targetIndex = tracks.value.findIndex((track: any) => track.id === trackId)
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
        .catch((error: unknown) => {
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

  const handleTrackMenuRemoveFromMixtape = async () => {
    const playlistId = String(payload.value.playlistId || '').trim()
    const trackId = String(trackContextTrackId.value || '').trim()
    closeTrackContextMenu()
    if (!playlistId || !trackId || !window?.electron?.ipcRenderer?.invoke) return
    try {
      await window.electron.ipcRenderer.invoke('mixtape:remove', {
        playlistId,
        itemIds: [trackId]
      })
    } catch (error) {
      console.error('[mixtape] remove track failed', {
        playlistId,
        itemId: trackId,
        error
      })
      await confirmDialog({
        title: t('common.error'),
        content: [t('mixtape.removeFromPlaylistFailed')],
        confirmShow: false
      })
    }
  }

  const handleBeatAlignDialogCancel = () => {
    beatAlignDialogVisible.value = false
    beatAlignTrackId.value = ''
  }

  const handleBeatAlignGridDefinitionSave = async (nextGrid: {
    barBeatOffset: number
    firstBeatMs: number
    bpm: number
  }) => {
    const playlistId = String(payload.value.playlistId || '').trim()
    const trackId = beatAlignTrackId.value
    if (!trackId) return
    const targetIndex = tracks.value.findIndex((track: any) => track.id === trackId)
    if (targetIndex < 0) return
    const currentTrack = tracks.value[targetIndex]
    if (!currentTrack) return
    const normalizedOffset = normalizeBarBeatOffset(nextGrid?.barBeatOffset)
    const normalizedFirstBeatMs = normalizeFirstBeatMs(nextGrid?.firstBeatMs)
    const normalizedInputBpm = normalizeBpm(nextGrid?.bpm)
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
    const isSameTrack = (track: any) =>
      targetFilePath.length > 0
        ? normalizeMixtapeFilePath(track.filePath) === targetFilePath
        : track.id === trackId
    const bpmChanged =
      shouldPersistBpm &&
      tracks.value.some((track: any) => {
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
    const activeEnvelopeParams =
      mixtapeMixMode.value === 'eq'
        ? MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL
        : MIXTAPE_ENVELOPE_PARAMS_STEM
    const shouldResetEnvelope = gridPositionChanged
      ? (await confirmDialog({
          title: t('mixtape.gridAdjustSaveResetEnvelopeTitle'),
          content: [t('mixtape.gridAdjustSaveResetEnvelopeHint')],
          confirmText: t('mixtape.gridAdjustSaveResetEnvelopeConfirm'),
          cancelText: t('mixtape.gridAdjustSaveResetEnvelopeCancel')
        })) === 'confirm'
      : false
    if (gridPositionChanged && !shouldResetEnvelope) return
    const nextTracks = tracks.value.map((track: any) => {
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
        originalBpm:
          shouldPersistBpm && normalizedInputBpm !== null
            ? Number(normalizedInputBpm)
            : track.originalBpm
      }
      if (!shouldResetEnvelope) return nextTrack
      for (const param of activeEnvelopeParams) {
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
    refreshTimelineForGlobalTempoChange()
    if (!window?.electron?.ipcRenderer?.invoke) return

    if (targetFilePath) {
      void window.electron.ipcRenderer
        .invoke('mixtape:update-grid-definition', {
          filePath: targetFilePath,
          barBeatOffset: normalizedOffset,
          firstBeatMs: normalizedFirstBeatMs,
          bpm: bpmChanged ? normalizedInputBpm : undefined
        })
        .catch((error: unknown) => {
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
    const affectedTracks = nextTracks.filter((track: any) => isSameTrack(track))
    if (!affectedTracks.length) return
    const envelopeUpdateTasks = activeEnvelopeParams.map((param: any) => {
      const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
      const entries = affectedTracks
        .map((track: any) => {
          const points = normalizeMixEnvelopePoints(
            param,
            (track as any)?.[envelopeField],
            resolveTrackDurationSeconds(track)
          )
          if (points.length < 2) return null
          return {
            itemId: track.id,
            gainEnvelope: points.map((point: any) => ({
              sec: Number(point.sec),
              gain: Number(point.gain)
            }))
          }
        })
        .filter(
          (
            item: any
          ): item is { itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> } =>
            item !== null
        )
      if (!entries.length) return Promise.resolve(null)
      return window.electron.ipcRenderer.invoke('mixtape:update-mix-envelope', {
        param,
        entries
      })
    })
    const muteSegmentUpdateEntries = affectedTracks.map((track: any) => ({
      itemId: track.id,
      segments: []
    }))
    const muteSegmentUpdateTask =
      muteSegmentUpdateEntries.length > 0
        ? window.electron.ipcRenderer.invoke('mixtape:update-volume-mute-segments', {
            entries: muteSegmentUpdateEntries
          })
        : Promise.resolve(null)
    const originalBpmUpdateTask =
      bpmChanged && normalizedInputBpm !== null
        ? window.electron.ipcRenderer.invoke('mixtape:update-track-start-sec', {
            entries: affectedTracks.map((track: any) => ({
              itemId: track.id,
              originalBpm: Number(normalizedInputBpm)
            }))
          })
        : Promise.resolve(null)
    void Promise.all([...envelopeUpdateTasks, muteSegmentUpdateTask, originalBpmUpdateTask]).catch(
      (error: unknown) => {
        console.error('[mixtape] reset mix envelope after grid update failed', {
          trackCount: affectedTracks.length,
          error
        })
      }
    )
    ensureDefaultGlobalTempoEnvelope(playlistId, {
      refreshWaveform: false
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
      transportPreloading.value ||
      stemSeparationProgressVisible.value ||
      stemRuntimeDownloadVisible.value ||
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
    if (mixtapeMixMode.value === 'stem') {
      const exportProfile = normalizeStemProfile(
        mixtapeStemProfile.value,
        DEFAULT_MIXTAPE_STEM_PROFILE
      )
      const exportModel = resolveMixtapeStemModelByProfile(exportProfile)
      const notReadyTracks = tracks.value.filter((track: any) => {
        if (normalizeMixtapeStemStatus(track.stemStatus) !== 'ready') return true
        if (!hasTrackStemPathsReady(track, mixtapeStemMode.value)) return true
        return resolveTrackStemModel(track) !== exportModel
      })
      if (notReadyTracks.length > 0) {
        const trackSample = notReadyTracks.slice(0, 3).map((track: any) => resolveTrackTitle(track))
        const filePaths = Array.from(
          new Set(
            notReadyTracks
              .map((track: any) => normalizeMixtapeFilePath(track.filePath))
              .filter((filePath: any): filePath is string => !!filePath)
          )
        )
        if (
          filePaths.length > 0 &&
          window?.electron?.ipcRenderer?.invoke &&
          payload.value.playlistId
        ) {
          try {
            await window.electron.ipcRenderer.invoke('mixtape:stem:enqueue', {
              playlistId: payload.value.playlistId,
              filePaths,
              stemMode: mixtapeStemMode.value,
              profile: exportProfile,
              force: false
            })
          } catch (error) {
            console.error('[mixtape] enqueue export stem profile failed', {
              playlistId: payload.value.playlistId,
              profile: exportProfile,
              count: filePaths.length,
              error
            })
          }
        }
        await confirmDialog({
          title: t('common.warning'),
          content: [
            t('mixtape.exportStemPreparing', { count: notReadyTracks.length }),
            ...trackSample
          ],
          confirmShow: false
        })
        return
      }
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

    const outputRequest = {
      outputPath: normalizedOutputPath,
      outputFormat: outputFormat.value,
      outputFilename: normalizedFilename
    }

    try {
      const rendered = await renderMixtapeOutputWav({
        onProgress: applyOutputProgressPayload
      })
      const result = await window.electron.ipcRenderer.invoke('mixtape:output', {
        ...outputRequest,
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
      const rawMessage = error instanceof Error ? error.message : String(error || t('common.error'))
      const message = t(rawMessage)
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

  const resetBpmAnalysisSession = () => {
    bpmAnalysisToken = 0
    lastBpmAnalysisKey = ''
    clearBpmAnalysisFailedTimer()
  }

  return {
    handleBpmBatchReady,
    clearBpmAnalysisFailedTimer,
    dismissBpmAnalysisFailure,
    retryBpmAnalysis,
    requestMixtapeBpmAnalysis,
    resetBpmAnalysisSession,
    loadMixtapeItems,
    closeTrackContextMenu,
    handleTrackContextMenu,
    handleTrackMenuAdjustGrid,
    handleTrackMenuToggleMasterTempo,
    handleTrackMenuRemoveFromMixtape,
    handleBeatAlignDialogCancel,
    handleBeatAlignGridDefinitionSave,
    handleGlobalPointerDown,
    handleWindowKeydown,
    openOutputDialog,
    applyOutputProgressPayload,
    handleOutputDialogConfirm,
    handleOutputDialogCancel
  }
}
