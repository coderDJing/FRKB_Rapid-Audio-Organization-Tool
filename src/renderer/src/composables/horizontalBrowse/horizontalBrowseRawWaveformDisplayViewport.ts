import { ref } from 'vue'

type RememberRenderViewportRequest = {
  renderToken: number
  rangeStartSec: number
  rangeDurationSec: number
  viewportRangeStartSec?: number
  viewportRangeDurationSec?: number
}

type RenderedViewportPayload = {
  renderToken: number
  rangeStartSec: number
  rangeDurationSec: number
}

export const createHorizontalBrowseRawWaveformDisplayViewportState = () => {
  const displayViewportStartSec = ref(0)
  const displayViewportDurationSec = ref(0)
  const displayViewportRevision = ref(0)
  const pendingRenderViewports = new Map<
    number,
    {
      startSec: number
      durationSec: number
    }
  >()

  const resetDisplayViewport = () => {
    displayViewportStartSec.value = 0
    displayViewportDurationSec.value = 0
    displayViewportRevision.value += 1
    pendingRenderViewports.clear()
  }

  const rememberRenderViewport = (request: RememberRenderViewportRequest) => {
    const startSec = Number(request.viewportRangeStartSec ?? request.rangeStartSec)
    const durationSec = Number(request.viewportRangeDurationSec ?? request.rangeDurationSec)
    if (!Number.isFinite(startSec) || !Number.isFinite(durationSec) || durationSec <= 0) return
    pendingRenderViewports.set(request.renderToken, {
      startSec,
      durationSec
    })
    for (const token of pendingRenderViewports.keys()) {
      if (token < request.renderToken - 8) pendingRenderViewports.delete(token)
    }
  }

  const applyDisplayViewport = (startSec: number, durationSec: number) => {
    if (!Number.isFinite(startSec) || !Number.isFinite(durationSec) || durationSec <= 0) {
      return false
    }
    displayViewportStartSec.value = startSec
    displayViewportDurationSec.value = durationSec
    displayViewportRevision.value += 1
    return true
  }

  const applyRenderedViewport = (payload: RenderedViewportPayload) => {
    const pendingViewport = pendingRenderViewports.get(payload.renderToken)
    pendingRenderViewports.delete(payload.renderToken)
    const startSec = Number(pendingViewport?.startSec ?? payload.rangeStartSec)
    const durationSec = Number(pendingViewport?.durationSec ?? payload.rangeDurationSec)
    applyDisplayViewport(startSec, durationSec)
  }

  return {
    displayViewportStartSec,
    displayViewportDurationSec,
    displayViewportRevision,
    resetDisplayViewport,
    rememberRenderViewport,
    applyDisplayViewport,
    applyRenderedViewport
  }
}
