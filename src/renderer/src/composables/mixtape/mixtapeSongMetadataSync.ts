import { normalizeSongBeatGridMap } from '@shared/songBeatGridMap'
import type { MixtapeRawItem, MixtapeTrack } from '@renderer/composables/mixtape/types'

type ValueRef<T> = {
  value: T
}

type SongGridUpdatedPayload = {
  filePath?: string
  bpm?: number
  firstBeatMs?: number
  barBeatOffset?: number
  timeBasisOffsetMs?: number
  beatGridSource?: 'manual' | 'analysis'
  beatGridMap?: MixtapeTrack['beatGridMap'] | null
}

type SongMetadataSyncContext = {
  tracks: ValueRef<MixtapeTrack[]>
  mixtapeRawItems: ValueRef<MixtapeRawItem[]>
  normalizeMixtapeFilePath: (value: unknown) => string
  normalizeBpm: (value: unknown) => number | null
  normalizeFirstBeatMs: (value: unknown) => number
  normalizeBarBeatOffset: (value: unknown) => number
  refreshMixtapeTrackDerivedUi: () => void
}

const normalizeMixtapeComparePath = (
  ctx: Pick<SongMetadataSyncContext, 'normalizeMixtapeFilePath'>,
  value: string | undefined | null
) => ctx.normalizeMixtapeFilePath(value).replace(/\//g, '\\').toLowerCase()

const parseMixtapeRawItemInfoJson = (item: MixtapeRawItem): Record<string, unknown> => {
  if (!item?.infoJson) return {}
  try {
    const parsed = JSON.parse(String(item.infoJson))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const patchMixtapeRawItemsByFilePath = (
  ctx: Pick<SongMetadataSyncContext, 'mixtapeRawItems' | 'normalizeMixtapeFilePath'>,
  filePath: string,
  patch: (info: Record<string, unknown>) => Record<string, unknown> | null
) => {
  const normalizedTargetPath = normalizeMixtapeComparePath(ctx, filePath)
  if (!normalizedTargetPath || ctx.mixtapeRawItems.value.length === 0) return false
  let touched = false
  const nextRawItems = ctx.mixtapeRawItems.value.map((item) => {
    if (normalizeMixtapeComparePath(ctx, item.filePath) !== normalizedTargetPath) return item
    const nextInfo = patch(parseMixtapeRawItemInfoJson(item))
    if (!nextInfo) return item
    const nextInfoJson = JSON.stringify(nextInfo)
    if (String(item.infoJson || '') === nextInfoJson) return item
    touched = true
    return {
      ...item,
      infoJson: nextInfoJson
    }
  })
  if (touched) {
    ctx.mixtapeRawItems.value = nextRawItems
  }
  return touched
}

export const createMixtapeSongMetadataSync = (ctx: SongMetadataSyncContext) => {
  const handleSongKeyUpdated = (
    _e: unknown,
    eventPayload: { filePath?: string; keyText?: string }
  ) => {
    const filePath = ctx.normalizeMixtapeFilePath(eventPayload?.filePath)
    const keyText = typeof eventPayload?.keyText === 'string' ? eventPayload.keyText.trim() : ''
    if (!filePath || !keyText) return
    const normalizedTargetPath = normalizeMixtapeComparePath(ctx, filePath)
    let trackTouched = false
    const nextTracks = ctx.tracks.value.map((track) => {
      if (normalizeMixtapeComparePath(ctx, track.filePath) !== normalizedTargetPath) return track
      const currentKey = typeof track.key === 'string' ? track.key.trim() : ''
      const currentOriginalKey =
        typeof track.originalKey === 'string' ? track.originalKey.trim() : ''
      if (currentKey === keyText && currentOriginalKey) return track
      trackTouched = true
      return {
        ...track,
        key: keyText,
        originalKey: currentOriginalKey || keyText
      }
    })
    if (trackTouched) {
      ctx.tracks.value = nextTracks
    }
    patchMixtapeRawItemsByFilePath(ctx, filePath, (info) => {
      const currentKey = typeof info.key === 'string' ? info.key.trim() : ''
      const currentOriginalKey = typeof info.originalKey === 'string' ? info.originalKey.trim() : ''
      if (currentKey === keyText && currentOriginalKey) return null
      return {
        ...info,
        key: keyText,
        originalKey: currentOriginalKey || keyText
      }
    })
  }

  const handleSongBpmUpdated = (_e: unknown, eventPayload: { filePath?: string; bpm?: number }) => {
    const filePath = ctx.normalizeMixtapeFilePath(eventPayload?.filePath)
    const bpmValue = ctx.normalizeBpm(eventPayload?.bpm)
    if (!filePath || bpmValue === null) return
    const normalizedTargetPath = normalizeMixtapeComparePath(ctx, filePath)
    let trackTouched = false
    const nextTracks = ctx.tracks.value.map((track) => {
      if (normalizeMixtapeComparePath(ctx, track.filePath) !== normalizedTargetPath) return track
      const currentBpm = Number(track.gridBaseBpm ?? track.originalBpm ?? track.bpm)
      if (Number.isFinite(currentBpm) && Math.abs(currentBpm - bpmValue) <= 0.0001) return track
      trackTouched = true
      return {
        ...track,
        gridBaseBpm: bpmValue,
        originalBpm: bpmValue,
        bpm: bpmValue,
        masterTempo: track.masterTempo !== false
      }
    })
    if (trackTouched) {
      ctx.tracks.value = nextTracks
    }
    const rawTouched = patchMixtapeRawItemsByFilePath(ctx, filePath, (info) => {
      const currentBpm = ctx.normalizeBpm(info.gridBaseBpm ?? info.originalBpm ?? info.bpm)
      if (currentBpm !== null && Math.abs(currentBpm - bpmValue) <= 0.0001) return null
      return {
        ...info,
        gridBaseBpm: bpmValue,
        originalBpm: bpmValue,
        bpm: bpmValue
      }
    })
    if (trackTouched || rawTouched) {
      ctx.refreshMixtapeTrackDerivedUi()
    }
  }

  const handleSongGridUpdated = (_e: unknown, eventPayload: SongGridUpdatedPayload) => {
    const filePath = ctx.normalizeMixtapeFilePath(eventPayload?.filePath)
    if (!filePath) return
    const normalizedTargetPath = normalizeMixtapeComparePath(ctx, filePath)
    const bpmValue = ctx.normalizeBpm(eventPayload?.bpm)
    const hasBpm = bpmValue !== null
    const hasFirstBeatMs =
      typeof eventPayload?.firstBeatMs === 'number' && Number.isFinite(eventPayload.firstBeatMs)
    const firstBeatMs = hasFirstBeatMs
      ? ctx.normalizeFirstBeatMs(eventPayload?.firstBeatMs)
      : undefined
    const hasBarBeatOffset =
      typeof eventPayload?.barBeatOffset === 'number' && Number.isFinite(eventPayload.barBeatOffset)
    const barBeatOffset = hasBarBeatOffset
      ? ctx.normalizeBarBeatOffset(eventPayload?.barBeatOffset)
      : undefined
    const hasTimeBasisOffsetMs =
      typeof eventPayload?.timeBasisOffsetMs === 'number' &&
      Number.isFinite(eventPayload.timeBasisOffsetMs)
    const timeBasisOffsetMs = hasTimeBasisOffsetMs
      ? ctx.normalizeFirstBeatMs(eventPayload?.timeBasisOffsetMs)
      : undefined
    const hasBeatGridMapPayload = Object.prototype.hasOwnProperty.call(eventPayload, 'beatGridMap')
    const nextBeatGridMap = normalizeSongBeatGridMap(eventPayload?.beatGridMap)
    const hasBeatGridMap = nextBeatGridMap !== null
    const shouldClearBeatGridMap = hasBeatGridMapPayload && eventPayload?.beatGridMap === null
    const hasBeatGridSource =
      eventPayload?.beatGridSource === 'manual' || eventPayload?.beatGridSource === 'analysis'
    if (
      !hasBpm &&
      !hasFirstBeatMs &&
      !hasBarBeatOffset &&
      !hasTimeBasisOffsetMs &&
      !hasBeatGridMapPayload &&
      !hasBeatGridSource
    ) {
      return
    }
    let trackTouched = false
    const nextTracks = ctx.tracks.value.map((track) => {
      if (normalizeMixtapeComparePath(ctx, track.filePath) !== normalizedTargetPath) return track
      const currentBpm = Number(track.gridBaseBpm ?? track.originalBpm ?? track.bpm)
      const bpmChanged =
        hasBpm && (!Number.isFinite(currentBpm) || Math.abs(currentBpm - Number(bpmValue)) > 0.0001)
      const currentFirstBeatMs = Number(track.firstBeatMs)
      const firstBeatChanged =
        hasFirstBeatMs &&
        (!Number.isFinite(currentFirstBeatMs) ||
          Math.abs(currentFirstBeatMs - Number(firstBeatMs)) > 0.001)
      const currentBarBeatOffset = Number(track.barBeatOffset)
      const barBeatOffsetChanged =
        hasBarBeatOffset &&
        (!Number.isFinite(currentBarBeatOffset) || currentBarBeatOffset !== barBeatOffset)
      const currentTimeBasisOffsetMs = Number(track.timeBasisOffsetMs)
      const timeBasisOffsetChanged =
        hasTimeBasisOffsetMs &&
        (!Number.isFinite(currentTimeBasisOffsetMs) ||
          Math.abs(currentTimeBasisOffsetMs - Number(timeBasisOffsetMs)) > 0.001)
      const beatGridMapChanged =
        (hasBeatGridMap && track.beatGridMap?.signature !== nextBeatGridMap.signature) ||
        (shouldClearBeatGridMap && track.beatGridMap !== undefined)
      if (
        !bpmChanged &&
        !firstBeatChanged &&
        !barBeatOffsetChanged &&
        !timeBasisOffsetChanged &&
        !beatGridMapChanged
      ) {
        return track
      }
      trackTouched = true
      const nextTrack: MixtapeTrack = {
        ...track,
        ...(hasBpm
          ? {
              gridBaseBpm: bpmValue || undefined,
              originalBpm: bpmValue || undefined,
              bpm: bpmValue || undefined,
              masterTempo: track.masterTempo !== false
            }
          : {}),
        ...(hasFirstBeatMs ? { firstBeatMs } : {}),
        ...(hasBarBeatOffset ? { barBeatOffset } : {}),
        ...(hasTimeBasisOffsetMs ? { timeBasisOffsetMs } : {}),
        ...(hasBeatGridMap ? { beatGridMap: nextBeatGridMap } : {})
      }
      if (shouldClearBeatGridMap) {
        delete nextTrack.beatGridMap
      }
      return nextTrack
    })
    if (trackTouched) {
      ctx.tracks.value = nextTracks
    }
    const rawTouched = patchMixtapeRawItemsByFilePath(ctx, filePath, (info) => {
      const currentBpm = ctx.normalizeBpm(info.gridBaseBpm ?? info.originalBpm ?? info.bpm)
      const bpmChanged =
        hasBpm && (currentBpm === null || Math.abs(currentBpm - Number(bpmValue)) > 0.0001)
      const currentFirstBeatMs = Number(info.firstBeatMs)
      const firstBeatChanged =
        hasFirstBeatMs &&
        (!Number.isFinite(currentFirstBeatMs) ||
          Math.abs(currentFirstBeatMs - Number(firstBeatMs)) > 0.001)
      const currentBarBeatOffset = Number(info.barBeatOffset)
      const barBeatOffsetChanged =
        hasBarBeatOffset &&
        (!Number.isFinite(currentBarBeatOffset) || currentBarBeatOffset !== barBeatOffset)
      const currentTimeBasisOffsetMs = Number(info.timeBasisOffsetMs)
      const timeBasisOffsetChanged =
        hasTimeBasisOffsetMs &&
        (!Number.isFinite(currentTimeBasisOffsetMs) ||
          Math.abs(currentTimeBasisOffsetMs - Number(timeBasisOffsetMs)) > 0.001)
      const currentBeatGridMap = normalizeSongBeatGridMap(info.beatGridMap)
      const beatGridMapChanged =
        (hasBeatGridMap && currentBeatGridMap?.signature !== nextBeatGridMap.signature) ||
        (shouldClearBeatGridMap && currentBeatGridMap !== null)
      if (
        !bpmChanged &&
        !firstBeatChanged &&
        !barBeatOffsetChanged &&
        !timeBasisOffsetChanged &&
        !beatGridMapChanged &&
        !hasBeatGridSource
      ) {
        return null
      }
      const nextInfo = {
        ...info,
        ...(hasBpm
          ? {
              gridBaseBpm: bpmValue,
              originalBpm: bpmValue,
              bpm: bpmValue
            }
          : {}),
        ...(hasFirstBeatMs ? { firstBeatMs } : {}),
        ...(hasBarBeatOffset ? { barBeatOffset } : {}),
        ...(hasTimeBasisOffsetMs ? { timeBasisOffsetMs } : {}),
        ...(hasBeatGridSource ? { beatGridSource: eventPayload.beatGridSource } : {}),
        ...(hasBeatGridMap ? { beatGridMap: nextBeatGridMap } : {})
      }
      if (shouldClearBeatGridMap) {
        delete nextInfo.beatGridMap
      }
      return nextInfo
    })
    if (trackTouched || rawTouched) {
      ctx.refreshMixtapeTrackDerivedUi()
    }
  }

  return {
    handleSongKeyUpdated,
    handleSongBpmUpdated,
    handleSongGridUpdated
  }
}
