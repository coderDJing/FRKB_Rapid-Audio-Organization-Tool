import type ConfirmDialog from '@renderer/components/confirmDialog'
import { normalizeSongBeatGridMap } from '@shared/songBeatGridMap'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMixMode,
  MixtapeOpenPayload,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'

type ValueRef<T> = {
  value: T
}

export type MixtapeEnvelopeField =
  | 'gainEnvelope'
  | 'highEnvelope'
  | 'midEnvelope'
  | 'lowEnvelope'
  | 'vocalEnvelope'
  | 'instEnvelope'
  | 'bassEnvelope'
  | 'drumsEnvelope'
  | 'volumeEnvelope'

export type MixtapeBeatAlignGridDefinitionPayload = {
  barBeatOffset: number
  firstBeatMs: number
  bpm: number
  beatGridMap?: MixtapeTrack['beatGridMap'] | null
}

type CreateMixtapeBeatAlignGridDefinitionSaverContext = {
  payload: ValueRef<MixtapeOpenPayload>
  tracks: ValueRef<MixtapeTrack[]>
  beatAlignTrackId: ValueRef<string>
  mixtapeMixMode: ValueRef<MixtapeMixMode>
  refreshTimelineForGlobalTempoChange: () => void
  ensureDefaultGlobalTempoEnvelope: (
    playlistId: string,
    options?: { refreshWaveform?: boolean }
  ) => void
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  normalizeMixtapeFilePath: (value: unknown) => string
  normalizeBarBeatOffset: (value: unknown) => number
  normalizeFirstBeatMs: (value: unknown) => number
  normalizeBpm: (value: unknown) => number | null
  MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL: MixtapeEnvelopeParamId[]
  MIXTAPE_ENVELOPE_PARAMS_STEM: MixtapeEnvelopeParamId[]
  MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM: Record<MixtapeEnvelopeParamId, MixtapeEnvelopeField>
  buildFlatMixEnvelope: (
    param: MixtapeEnvelopeParamId,
    durationSec: number,
    gain?: number
  ) => MixtapeGainPoint[]
  normalizeMixEnvelopePoints: (
    param: MixtapeEnvelopeParamId,
    value: unknown,
    durationSec?: number
  ) => MixtapeGainPoint[]
  confirmDialog: typeof ConfirmDialog
  t: (key: string, payload?: Record<string, unknown>) => string
}

const getTrackEnvelopeField = (value: unknown): MixtapeEnvelopeField =>
  value as MixtapeEnvelopeField

export const createMixtapeBeatAlignGridDefinitionSaver = (
  ctx: CreateMixtapeBeatAlignGridDefinitionSaverContext
) => {
  const {
    payload,
    tracks,
    beatAlignTrackId,
    mixtapeMixMode,
    refreshTimelineForGlobalTempoChange,
    ensureDefaultGlobalTempoEnvelope,
    resolveTrackDurationSeconds,
    normalizeMixtapeFilePath,
    normalizeBarBeatOffset,
    normalizeFirstBeatMs,
    normalizeBpm,
    MIXTAPE_ENVELOPE_PARAMS_TRADITIONAL,
    MIXTAPE_ENVELOPE_PARAMS_STEM,
    MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM,
    buildFlatMixEnvelope,
    normalizeMixEnvelopePoints,
    confirmDialog,
    t
  } = ctx

  return async (nextGrid: MixtapeBeatAlignGridDefinitionPayload) => {
    const playlistId = String(payload.value.playlistId || '').trim()
    const trackId = beatAlignTrackId.value
    if (!trackId) return
    const targetIndex = tracks.value.findIndex((track: MixtapeTrack) => track.id === trackId)
    if (targetIndex < 0) return
    const currentTrack = tracks.value[targetIndex]
    if (!currentTrack) return
    const normalizedOffset = normalizeBarBeatOffset(nextGrid?.barBeatOffset)
    const normalizedFirstBeatMs = normalizeFirstBeatMs(nextGrid?.firstBeatMs)
    const normalizedInputBpm = normalizeBpm(nextGrid?.bpm)
    const hasBeatGridMapInput = Object.prototype.hasOwnProperty.call(nextGrid || {}, 'beatGridMap')
    const nextBeatGridMap = normalizeSongBeatGridMap(nextGrid?.beatGridMap)
    const shouldClearBeatGridMap = hasBeatGridMapInput && nextGrid?.beatGridMap === null
    const currentOffset = normalizeBarBeatOffset(currentTrack.barBeatOffset)
    const currentFirstBeatMs = normalizeFirstBeatMs(currentTrack.firstBeatMs)
    const offsetChanged = normalizedOffset !== currentOffset
    const firstBeatChanged = Math.abs(normalizedFirstBeatMs - currentFirstBeatMs) > 0.0001
    const beatGridMapChanged =
      (nextBeatGridMap !== null &&
        currentTrack.beatGridMap?.signature !== nextBeatGridMap.signature) ||
      (shouldClearBeatGridMap && currentTrack.beatGridMap !== undefined)
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
      tracks.value.some((track: MixtapeTrack) => {
        if (!isSameTrack(track)) return false
        const trackBpmBase =
          normalizeBpm(track.gridBaseBpm) ??
          normalizeBpm(track.originalBpm) ??
          normalizeBpm(track.bpm)
        if (trackBpmBase === null) return true
        return Math.abs(trackBpmBase - Number(normalizedInputBpm)) > 0.0001
      })
    if (!offsetChanged && !firstBeatChanged && !bpmChanged && !beatGridMapChanged) return
    const gridPositionChanged = firstBeatChanged || bpmChanged || beatGridMapChanged
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
    const nextTracks = tracks.value.map((track: MixtapeTrack) => {
      if (!isSameTrack(track)) return track
      const fallbackGridBaseBpm =
        normalizeBpm(track.gridBaseBpm) ?? normalizeBpm(track.originalBpm) ?? track.gridBaseBpm
      const nextTrack: MixtapeTrack = {
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
      if (nextBeatGridMap) {
        nextTrack.beatGridMap = nextBeatGridMap
      } else if (shouldClearBeatGridMap) {
        delete nextTrack.beatGridMap
      }
      if (!shouldResetEnvelope) return nextTrack
      for (const param of activeEnvelopeParams as MixtapeEnvelopeParamId[]) {
        const envelopeField = getTrackEnvelopeField(MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param])
        nextTrack[envelopeField] = buildFlatMixEnvelope(
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
          bpm: bpmChanged ? normalizedInputBpm : undefined,
          beatGridMap: nextBeatGridMap ?? (shouldClearBeatGridMap ? null : undefined)
        })
        .catch((error: unknown) => {
          console.error('[mixtape] update grid definition failed', {
            filePath: targetFilePath,
            barBeatOffset: normalizedOffset,
            firstBeatMs: normalizedFirstBeatMs,
            bpm: bpmChanged ? normalizedInputBpm : undefined,
            beatGridMap: nextBeatGridMap ?? (shouldClearBeatGridMap ? null : undefined),
            error
          })
        })
    }

    if (!shouldResetEnvelope) return
    const affectedTracks = nextTracks.filter((track: MixtapeTrack) => isSameTrack(track))
    if (!affectedTracks.length) return
    const envelopeUpdateTasks = (activeEnvelopeParams as MixtapeEnvelopeParamId[]).map((param) => {
      const envelopeField = getTrackEnvelopeField(MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param])
      const entries = affectedTracks
        .map((track: MixtapeTrack) => {
          const points = normalizeMixEnvelopePoints(
            param,
            track[envelopeField],
            resolveTrackDurationSeconds(track)
          ) as MixtapeGainPoint[]
          if (points.length < 2) return null
          return {
            itemId: track.id,
            gainEnvelope: points.map((point: MixtapeGainPoint) => ({
              sec: Number(point.sec),
              gain: Number(point.gain)
            }))
          }
        })
        .filter(
          (
            item: { itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> } | null
          ): item is { itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> } =>
            item !== null
        )
      if (!entries.length) return Promise.resolve(null)
      return window.electron.ipcRenderer.invoke('mixtape:update-mix-envelope', {
        param,
        entries
      })
    })
    const muteSegmentUpdateEntries = affectedTracks.map((track: MixtapeTrack) => ({
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
            entries: affectedTracks.map((track: MixtapeTrack) => ({
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
}
