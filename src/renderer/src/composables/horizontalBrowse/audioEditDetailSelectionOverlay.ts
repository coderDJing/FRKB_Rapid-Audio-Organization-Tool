type AudioEditViewportRange = {
  startSec: number
  endSec: number
}

export type AudioEditOverlayViewportInput = {
  dragging: boolean
  displayViewportStartSec: number
  displayViewportDurationSec: number
  previewStartSec: number
  visibleDurationSec: number
}

export type AudioEditOverlayViewport = {
  startSec: number
  durationSec: number
}

// 未拖拽时用 canvas 已提交的可见窗口；拖拽中改用 preview，避免高亮粘在播放头上。
// 松手后仍走 displayViewport：播放头秒数可能还停在拖拽前，不能立刻改回 preview。
export const resolveAudioEditOverlayViewport = (
  input: AudioEditOverlayViewportInput
): AudioEditOverlayViewport => {
  const usePreview = input.dragging || !(input.displayViewportDurationSec > 0)
  if (usePreview) {
    const durationSec =
      input.visibleDurationSec > 0 ? input.visibleDurationSec : input.displayViewportDurationSec
    return {
      startSec: input.previewStartSec,
      durationSec
    }
  }
  return {
    startSec: input.displayViewportStartSec,
    durationSec: input.displayViewportDurationSec
  }
}

const toFiniteNumber = (value: number | null | undefined) => {
  if (value == null) return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

export const resolveAudioEditViewportSelectionStyle = (
  range: AudioEditViewportRange | null | undefined,
  viewportStartSec: number,
  viewportDurationSec: number
): { left: string; width: string } | null => {
  if (!range || !(viewportDurationSec > 0)) return null
  const startSec = Math.max(0, Number(range.startSec) || 0)
  const endSec = Math.max(startSec, Number(range.endSec) || 0)
  if (endSec <= startSec) return null
  const visibleStart = Math.max(viewportStartSec, startSec)
  const visibleEnd = Math.min(viewportStartSec + viewportDurationSec, endSec)
  if (visibleEnd <= visibleStart) return null
  return {
    left: `${((visibleStart - viewportStartSec) / viewportDurationSec) * 100}%`,
    width: `${((visibleEnd - visibleStart) / viewportDurationSec) * 100}%`
  }
}

export const resolveAudioEditViewportBoundStyle = (
  seconds: number | null | undefined,
  viewportStartSec: number,
  viewportDurationSec: number
): { left: string } | null => {
  const boundSec = toFiniteNumber(seconds)
  if (boundSec == null || !(viewportDurationSec > 0)) return null
  const ratio = (boundSec - viewportStartSec) / viewportDurationSec
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return null
  return { left: `${ratio * 100}%` }
}
