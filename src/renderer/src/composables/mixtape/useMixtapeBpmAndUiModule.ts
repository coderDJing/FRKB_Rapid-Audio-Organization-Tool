import { nextTick } from 'vue'
import { resolveContextMenuPoint } from '@renderer/utils/contextMenuPosition'

export const createUseMixtapeBpmAndUiModule = (ctx: any) => {
  const {
    payload,
    tracks,
    mixtapeRawItems,
    selectedTrackId,
    mixtapeMixMode,
    mixtapeStemMode,
    mixtapeStemRealtimeProfile,
    mixtapeStemExportProfile,
    outputStemProfile,
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
    bpmAnalysisFailedAutoCloseSeconds,
    mixtapeStemStrategyConfirmed,
    stemSummary,
    stemRuntimeProgressByTrackId,
    stemResumeBootstrappedPlaylistIdSet,
    stemResumeSignatureByPlaylistId,
    autoGainDialogVisible,
    transportPlaying,
    transportDecoding,
    shouldShowOutputStemProfileSelect,
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
    DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE,
    DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE,
    confirmDialog,
    t,
    handleTransportStop,
    handleTransportPlayFromStart
  } = ctx

  let bpmAnalysisToken = 0
  let lastBpmAnalysisKey = ''
  let bpmAnalysisFailedTimer: ReturnType<typeof setTimeout> | null = null

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
      dismissBpmAnalysisFailure()
    } else if (bpmAnalysisFailed.value) {
      bpmAnalysisFailedCount.value = missingTrackCount
      scheduleBpmAnalysisFailureAutoClose()
    }
    scheduleTimelineDraw()
  }

  const clearBpmAnalysisFailedTimer = () => {
    if (!bpmAnalysisFailedTimer) return
    clearTimeout(bpmAnalysisFailedTimer)
    bpmAnalysisFailedTimer = null
  }

  const dismissBpmAnalysisFailure = () => {
    clearBpmAnalysisFailedTimer()
    bpmAnalysisFailed.value = false
    bpmAnalysisFailedCount.value = 0
  }

  const scheduleBpmAnalysisFailureAutoClose = () => {
    clearBpmAnalysisFailedTimer()
    bpmAnalysisFailedTimer = setTimeout(() => {
      if (!bpmAnalysisActive.value) {
        dismissBpmAnalysisFailure()
      }
    }, bpmAnalysisFailedAutoCloseSeconds * 1000)
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
          scheduleBpmAnalysisFailureAutoClose()
        } else {
          allResolved = true
        }
      } else if (filePaths.length > 0) {
        bpmAnalysisFailed.value = true
        bpmAnalysisFailedCount.value = Math.max(unresolved.length, filePaths.length)
        scheduleBpmAnalysisFailureAutoClose()
      }
    } catch (error) {
      bpmAnalysisFailed.value = true
      bpmAnalysisFailedCount.value = Math.max(filePaths.length, 1)
      scheduleBpmAnalysisFailureAutoClose()
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

  const loadMixtapeItems = async () => {
    if (!payload.value.playlistId) {
      mixtapeRawItems.value = []
      mixtapeMixMode.value = 'stem'
      mixtapeStemMode.value = '4stems'
      mixtapeStemRealtimeProfile.value = DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
      mixtapeStemExportProfile.value = DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
      outputStemProfile.value = DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
      mixtapeStemStrategyConfirmed.value = false
      stemSummary.value = createEmptyStemSummary()
      stemRuntimeProgressByTrackId.value = {}
      tracks.value = []
      selectedTrackId.value = ''
      resetAutoGainState()
      bpmAnalysisActive.value = false
      dismissBpmAnalysisFailure()
      lastBpmAnalysisKey = ''
      return
    }
    const result = await window.electron.ipcRenderer.invoke('mixtape:list', {
      playlistId: payload.value.playlistId
    })
    mixtapeMixMode.value = normalizeMixtapeMixMode(result?.mixMode)
    mixtapeStemMode.value = normalizeMixtapeStemMode(result?.stemMode)
    mixtapeStemRealtimeProfile.value = normalizeStemProfile(
      result?.stemRealtimeProfile,
      DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
    )
    mixtapeStemExportProfile.value = normalizeStemProfile(
      result?.stemExportProfile,
      DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
    )
    outputStemProfile.value = normalizeStemProfile(
      result?.stemExportProfile,
      DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
    )
    mixtapeStemStrategyConfirmed.value = !!result?.stemStrategyConfirmed
    stemSummary.value = normalizeStemSummary(result?.stemSummary)
    const rawItems = Array.isArray(result?.items) ? result.items : []
    mixtapeRawItems.value = rawItems
    const removedPaths = Array.isArray(result?.recovery?.removedPaths)
      ? normalizeUniquePaths(result.recovery.removedPaths)
      : []
    tracks.value = rawItems.map((item: any, index: number) =>
      parseSnapshot(item, index, t('tracks.unknownTrack'))
    )
    pruneStemRuntimeProgressByTracks(tracks.value)
    const stemMode = normalizeMixtapeStemMode(result?.stemMode)
    const currentPlaylistId = String(payload.value.playlistId || '').trim()

    if (mixtapeMixMode.value === 'stem' && mixtapeStemStrategyConfirmed.value) {
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
              playlistId: payload.value.playlistId,
              filePaths: repairFilePaths,
              stemMode,
              profile: mixtapeStemRealtimeProfile.value,
              force: false
            })
            .catch((error: unknown) => {
              console.error('[mixtape] stem path backfill enqueue failed', {
                playlistId: payload.value.playlistId,
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
        stemResumeBootstrappedPlaylistIdSet.add(currentPlaylistId)
      }
    } else if (currentPlaylistId) {
      stemResumeBootstrappedPlaylistIdSet.delete(currentPlaylistId)
      stemResumeSignatureByPlaylistId.delete(currentPlaylistId)
      console.info('[mixtape] stem auto enqueue skipped: non-stem mode or strategy not confirmed', {
        playlistId: currentPlaylistId
      })
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
      void notifyMissingTracksRemoved(payload.value.playlistId || '', removedPaths)
    }
    void requestMixtapeBpmAnalysis()
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
    const menuWidth = 150
    const menuHeight = 70
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
    const targetIndex = tracks.value.findIndex((track: any) => track.id === trackId)
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
      mixtapeMixMode.value === 'traditional'
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
        bpm:
          shouldPersistBpm && normalizedInputBpm !== null ? Number(normalizedInputBpm) : track.bpm
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
    void Promise.all([...envelopeUpdateTasks, muteSegmentUpdateTask]).catch((error: unknown) => {
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
    outputStemProfile.value = shouldShowOutputStemProfileSelect.value
      ? 'quality'
      : normalizeStemProfile(mixtapeStemExportProfile.value, DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE)
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
        shouldShowOutputStemProfileSelect.value
          ? outputStemProfile.value
          : mixtapeStemExportProfile.value,
        DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
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
    stemProfile?: any
  }) => {
    outputPath.value = payload.outputPath
    outputFormat.value = payload.outputFormat
    outputFilename.value = payload.outputFilename
    outputStemProfile.value = normalizeStemProfile(payload.stemProfile, outputStemProfile.value)
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
