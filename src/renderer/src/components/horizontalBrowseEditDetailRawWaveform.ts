import {
  PREVIEW_EDIT_RAW_TARGET_RATE,
  PREVIEW_RAW_TARGET_RATE
} from '@renderer/components/MixtapeBeatAlignDialog.constants'

const HORIZONTAL_BROWSE_BOOTSTRAP_OVERSCAN = 8
const HORIZONTAL_BROWSE_DEFERRED_BOOTSTRAP_OVERSCAN = 1.5
const HORIZONTAL_BROWSE_EDIT_RAW_WINDOW_OVERSCAN = 2.5
const HORIZONTAL_BROWSE_EDIT_RAW_WINDOW_MIN_SEC = 6
const HORIZONTAL_BROWSE_EDIT_RAW_WINDOW_MAX_SEC = 36
const HORIZONTAL_BROWSE_EDIT_RAW_WINDOW_MIN_LEAD_SEC = 0.5

export type HorizontalBrowseRawWaveformStreamMode = 'rolling' | 'edit-window'

type ResolveHorizontalBrowseRawWaveformStreamParamsInput = {
  layout: string
  visibleDurationSec: number
  durationSec: number
  deferred: boolean
}

export const isHorizontalBrowseEditRawWindowMode = (
  mode: HorizontalBrowseRawWaveformStreamMode | undefined
) => mode === 'edit-window'

export const resolveHorizontalBrowseEditRawWindowLeadSec = (visibleDurationSec: number) =>
  Math.max(
    HORIZONTAL_BROWSE_EDIT_RAW_WINDOW_MIN_LEAD_SEC,
    resolveEditWindowDurationSec(visibleDurationSec, 0) * 0.5
  )

const resolveEditWindowDurationSec = (visibleDurationSec: number, durationSec: number) => {
  const visible = Math.max(0.001, Number(visibleDurationSec) || 0.001)
  const duration = Math.max(0, Number(durationSec) || 0)
  const windowSec = Math.min(
    HORIZONTAL_BROWSE_EDIT_RAW_WINDOW_MAX_SEC,
    Math.max(
      HORIZONTAL_BROWSE_EDIT_RAW_WINDOW_MIN_SEC,
      visible * HORIZONTAL_BROWSE_EDIT_RAW_WINDOW_OVERSCAN
    )
  )
  return duration > 0 ? Math.min(duration, windowSec) : windowSec
}

export const resolveHorizontalBrowseRawWaveformStreamParams = (
  input: ResolveHorizontalBrowseRawWaveformStreamParamsInput
) => {
  const visibleDurationSec = Math.max(0.001, Number(input.visibleDurationSec) || 0.001)
  const editDetail = input.layout === 'full'
  if (editDetail) {
    return {
      mode: 'edit-window' as const,
      targetRate: PREVIEW_EDIT_RAW_TARGET_RATE,
      bootstrapDurationSec: resolveEditWindowDurationSec(
        input.visibleDurationSec,
        input.durationSec
      )
    }
  }
  const overscan = input.deferred
    ? HORIZONTAL_BROWSE_DEFERRED_BOOTSTRAP_OVERSCAN
    : HORIZONTAL_BROWSE_BOOTSTRAP_OVERSCAN
  return {
    mode: 'rolling' as const,
    targetRate: PREVIEW_RAW_TARGET_RATE,
    bootstrapDurationSec: Math.max(input.deferred ? 1.5 : 4, visibleDurationSec * overscan)
  }
}
