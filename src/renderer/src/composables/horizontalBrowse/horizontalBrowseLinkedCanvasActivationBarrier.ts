import type { HorizontalBrowseDirection } from './horizontalBrowseRawWaveformCanvasTypes'

type PendingActivation = {
  commit: () => void
}

const LINKED_ACTIVATION_FALLBACK_MS = 120

const pendingActivations: Partial<Record<HorizontalBrowseDirection, PendingActivation>> = {}
let firstAnimationFrame = 0
let secondAnimationFrame = 0
let fallbackTimer: ReturnType<typeof setTimeout> | null = null

const clearScheduledFlush = () => {
  if (firstAnimationFrame) cancelAnimationFrame(firstAnimationFrame)
  if (secondAnimationFrame) cancelAnimationFrame(secondAnimationFrame)
  if (fallbackTimer) clearTimeout(fallbackTimer)
  firstAnimationFrame = 0
  secondAnimationFrame = 0
  fallbackTimer = null
}

const flushPendingActivations = () => {
  clearScheduledFlush()
  const up = pendingActivations.up
  const down = pendingActivations.down
  delete pendingActivations.up
  delete pendingActivations.down
  // 两个回调必须在同一个 JS 任务内完成，浏览器才不会绘制只切换了一轨的中间帧。
  up?.commit()
  down?.commit()
}

const schedulePairedFlush = () => {
  if (firstAnimationFrame || secondAnimationFrame) return
  firstAnimationFrame = requestAnimationFrame(() => {
    firstAnimationFrame = 0
    secondAnimationFrame = requestAnimationFrame(() => {
      secondAnimationFrame = 0
      flushPendingActivations()
    })
  })
}

const scheduleFallbackFlush = () => {
  if (fallbackTimer) return
  fallbackTimer = setTimeout(flushPendingActivations, LINKED_ACTIVATION_FALLBACK_MS)
}

export const queueHorizontalBrowseLinkedCanvasActivation = (
  direction: HorizontalBrowseDirection,
  commit: () => void
) => {
  // 同一轨在联结松手后可能连续产出过渡帧和校正帧；只保留绘制前最后一帧。
  pendingActivations[direction] = { commit }
  if (pendingActivations.up && pendingActivations.down) {
    schedulePairedFlush()
    return
  }
  scheduleFallbackFlush()
}

export const resetHorizontalBrowseLinkedCanvasActivationBarrier = () => {
  clearScheduledFlush()
  delete pendingActivations.up
  delete pendingActivations.down
}
