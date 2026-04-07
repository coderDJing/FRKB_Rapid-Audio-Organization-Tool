export const parseHorizontalBrowseDurationToSeconds = (input: unknown) => {
  const raw = String(input || '').trim()
  if (!raw) return 0
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) || 0)
  const parts = raw
    .split(':')
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part))
  if (!parts.length) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0]
}

export const resolveHorizontalBrowseDeckDurationSeconds = (
  explicitDuration: unknown,
  songDuration: unknown
) => {
  const explicit = Number(explicitDuration)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return parseHorizontalBrowseDurationToSeconds(songDuration)
}

export const resolveHorizontalBrowseDeckGridBpm = (
  effectiveBpmValue: unknown,
  playbackRateValue: unknown,
  songBpmValue: unknown
) => {
  const effectiveBpm = Number(effectiveBpmValue) || 0
  const playbackRate = Number(playbackRateValue) || 1
  if (effectiveBpm > 0 && playbackRate > 0) {
    return effectiveBpm / playbackRate
  }
  return Number(songBpmValue) || 0
}

export const resolveHorizontalBrowseDeckSyncUiEnabled = (
  hasSong: boolean,
  syncEnabled: boolean,
  cuePreviewActive: boolean,
  cuePreviewSyncEnabledBefore: boolean
) => {
  return hasSong && (syncEnabled || (cuePreviewActive && cuePreviewSyncEnabledBefore))
}

export const resolveHorizontalBrowseDeckSyncUiLock = (
  hasSong: boolean,
  syncLock: string,
  cuePreviewActive: boolean,
  cuePreviewSyncEnabledBefore: boolean,
  cuePreviewSyncLockBefore: string
) => {
  if (!hasSong) return 'off'
  return cuePreviewActive && cuePreviewSyncEnabledBefore ? cuePreviewSyncLockBefore : syncLock
}

export const buildHorizontalBrowseDeckToolbarState = (
  toolbarState: {
    disabled: boolean
    bpmStep: number
    bpmMin: number
    bpmMax: number
    barLinePicking: boolean
  },
  bpmInputValue: string
) => ({
  disabled: toolbarState.disabled,
  bpmInputValue,
  bpmStep: toolbarState.bpmStep,
  bpmMin: toolbarState.bpmMin,
  bpmMax: toolbarState.bpmMax,
  barLinePicking: toolbarState.barLinePicking
})
