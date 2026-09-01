import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHorizontalBrowseStableCanvasPresentationController,
  type HorizontalBrowseStableCanvasPresentationFrame
} from './horizontalBrowseStableCanvasPresentation'

const PLAYHEAD_RATIO = 0.5

// jsdom/node 环境没有 requestAnimationFrame；handleRendered 会启动播放 RAF 循环，这里 no-op 即可。
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// 复刻 composable 里的对齐公式：屏幕左缘 = seconds - visibleDuration * playheadRatio。
const alignedStart = (seconds: number, visibleDurationSec: number) =>
  seconds - visibleDurationSec * PLAYHEAD_RATIO

// 造一个“旧密度帧”：视口一屏对应 oldVisible 秒，overscan 各占 renderWidth 的比例。
const createStaleDensityFrame = (
  currentSeconds: number,
  oldVisibleSec: number
): HorizontalBrowseStableCanvasPresentationFrame => {
  const viewportWidth = 700
  const overscanCssPx = viewportWidth * 3
  const renderWidth = viewportWidth + overscanCssPx * 2
  const rangeDurationSec = (oldVisibleSec * renderWidth) / viewportWidth
  // 帧按旧密度绘制，rangeStart 对齐到播放头位于视口 50%。
  const viewportRangeStartSec = alignedStart(currentSeconds, oldVisibleSec)
  const rangeStartSec = viewportRangeStartSec - (rangeDurationSec * overscanCssPx) / renderWidth
  return {
    renderToken: 1,
    renderRevision: 0,
    playbackActive: true,
    rangeStartSec,
    rangeDurationSec,
    viewportRangeStartSec,
    anchorSec: currentSeconds,
    anchorStartedAtMs: 0,
    playbackRate: 1,
    renderWidth,
    overscanCssPx,
    pixelRatio: 1
  }
}

describe('horizontalBrowseStableCanvasPresentation tempo 过渡对齐', () => {
  it('过渡期用帧自身密度可见时长对齐时，播放头保持贴住 currentSeconds（不横跳）', () => {
    const currentSeconds = 2.2229
    const oldVisibleSec = 12 // 帧仍是旧密度：一屏 12s
    const newVisibleSec = 9.4181 // 当前 rate 已变小：一屏 9.4181s
    const frame = createStaleDensityFrame(currentSeconds, oldVisibleSec)

    // resolveViewportRangeStartSec 收到 override 时用它，否则用当前 rate 的 visibleDuration。
    const resolveViewportRangeStartSec = vi.fn(
      (seconds: number, visibleDurationOverrideSec?: number) =>
        alignedStart(seconds, visibleDurationOverrideSec ?? newVisibleSec)
    )

    const controller = createHorizontalBrowseStableCanvasPresentationController({
      isActive: () => true,
      isPlaying: () => true,
      isDragging: () => false,
      currentSeconds: () => currentSeconds,
      playbackRate: () => 1,
      renderRevision: () => 0,
      resolveViewportRangeStartSec,
      waveformCanvas: () => null,
      overlayCanvas: () => null,
      scheduleDraw: () => {}
    })

    controller.queueFrame(frame)
    controller.handleRendered({
      renderToken: 1,
      rangeStartSec: frame.rangeStartSec,
      rangeDurationSec: frame.rangeDurationSec,
      ready: true
    })

    const measured = controller.measure(currentSeconds)

    // 控制器应传入帧自身密度对应的可见时长（≈oldVisible），而不是当前 rate 的 newVisible。
    const passedOverride = resolveViewportRangeStartSec.mock.calls
      .map((call) => call[1])
      .find((value) => value != null)
    expect(passedOverride).toBeCloseTo(oldVisibleSec, 4)

    // offset≈0：帧本就对齐到播放头=currentSeconds，用帧自身密度对齐不产生横向位移。
    expect(measured.offsetCssPx ?? 0).toBeCloseTo(0, 3)
  })

  it('普通播放（帧密度==当前 rate）时，override 与默认一致，行为不变', () => {
    const currentSeconds = 5
    const visibleSec = 10
    const frame = createStaleDensityFrame(currentSeconds, visibleSec)

    const resolveViewportRangeStartSec = vi.fn(
      (seconds: number, visibleDurationOverrideSec?: number) =>
        alignedStart(seconds, visibleDurationOverrideSec ?? visibleSec)
    )

    const controller = createHorizontalBrowseStableCanvasPresentationController({
      isActive: () => true,
      isPlaying: () => true,
      isDragging: () => false,
      currentSeconds: () => currentSeconds,
      playbackRate: () => 1,
      renderRevision: () => 0,
      resolveViewportRangeStartSec,
      waveformCanvas: () => null,
      overlayCanvas: () => null,
      scheduleDraw: () => {}
    })

    controller.queueFrame(frame)
    controller.handleRendered({
      renderToken: 1,
      rangeStartSec: frame.rangeStartSec,
      rangeDurationSec: frame.rangeDurationSec,
      ready: true
    })

    const measured = controller.measure(currentSeconds)
    expect(measured.offsetCssPx ?? 0).toBeCloseTo(0, 3)
  })
})
