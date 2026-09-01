import { HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveform.constants'

const LIVE_TEMPO_ORIGIN = `${HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO * 100}% 50%`

export const resolveHorizontalBrowseLiveTempoPreviewScaleX = (
  displayedRate: number,
  targetRate: number | null | undefined
) => {
  const safeDisplayed = Math.max(0.25, Number(displayedRate) || 1)
  const safeTarget = Number(targetRate)
  if (targetRate == null || !Number.isFinite(safeTarget) || safeTarget <= 0) return 1
  return safeDisplayed / Math.max(0.25, safeTarget)
}

type HorizontalBrowseLiveTempoPreviewVisualGeometryOptions = {
  renderedViewportStartSec: number | null
  targetVisibleDurationSec: number
  renderedTimeScale: number
  targetTimeScale: number
  cssScaleX: number
}

export const resolveHorizontalBrowseLiveTempoPreviewVisualGeometry = ({
  renderedViewportStartSec,
  targetVisibleDurationSec,
  renderedTimeScale,
  targetTimeScale,
  cssScaleX
}: HorizontalBrowseLiveTempoPreviewVisualGeometryOptions) => {
  const safeTargetVisibleDurationSec = Math.max(0.001, Number(targetVisibleDurationSec) || 0.001)
  const safeRenderedTimeScale = Math.max(0.25, Number(renderedTimeScale) || 1)
  const safeTargetTimeScale = Math.max(0.25, Number(targetTimeScale) || 1)
  const safeCssScaleX = Math.max(0.0001, Number(cssScaleX) || 1)
  const renderedVisibleDurationSec =
    safeTargetVisibleDurationSec * (safeRenderedTimeScale / safeTargetTimeScale)
  const effectiveVisibleDurationSec = renderedVisibleDurationSec / safeCssScaleX
  const effectiveViewportStartSec =
    renderedViewportStartSec == null || !Number.isFinite(renderedViewportStartSec)
      ? null
      : renderedViewportStartSec +
        (renderedVisibleDurationSec - effectiveVisibleDurationSec) *
          HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
  const effectivePlayheadSec =
    effectiveViewportStartSec == null
      ? null
      : effectiveViewportStartSec +
        effectiveVisibleDurationSec * HORIZONTAL_BROWSE_DETAIL_PLAYHEAD_RATIO
  return {
    renderedVisibleDurationSec,
    effectiveViewportStartSec,
    effectiveVisibleDurationSec,
    effectivePlayheadSec
  }
}

export const HORIZONTAL_BROWSE_LIVE_TEMPO_RELEASE_EPSILON = 0.0001

/**
 * 松手离场（liveRate=null）时，判断该立即归零 scaleX 还是延迟到 worker 新帧上屏再归零。
 *
 * displayed 已在目标密度时立即归零不会跳；否则保持 scaleX 拉伸态、把 target 钉在提交的
 * 目标密度，等 onPresentedPreviewTimeScale 令 displayed 追上目标时再归零，令归位与换帧同帧发生。
 */
export const resolveHorizontalBrowseLiveTempoPreviewReleasePlan = (
  displayedRate: number,
  targetRate: number,
  epsilon: number = HORIZONTAL_BROWSE_LIVE_TEMPO_RELEASE_EPSILON
): { mode: 'immediate' | 'deferred'; pendingScale: number } => {
  const safeDisplayed = Math.max(0.25, Number(displayedRate) || 1)
  const safeTarget = Math.max(0.25, Number(targetRate) || 1)
  const safeEpsilon = Math.max(0, Number(epsilon) || 0)
  if (Math.abs(safeDisplayed - safeTarget) <= safeEpsilon) {
    return { mode: 'immediate', pendingScale: safeTarget }
  }
  return { mode: 'deferred', pendingScale: safeTarget }
}

/**
 * 延迟归位期间收到 worker 新帧（displayed 更新）后，判断是否该完成归零。
 * displayed 追上 pending 目标时返回 true，此刻 scaleX≈1，归零无跳变。
 */
export const shouldFinishHorizontalBrowseLiveTempoPreviewRelease = (
  displayedRate: number,
  pendingScale: number | null,
  epsilon: number = HORIZONTAL_BROWSE_LIVE_TEMPO_RELEASE_EPSILON
) => {
  if (pendingScale == null) return false
  const safeDisplayed = Math.max(0.25, Number(displayedRate) || 1)
  const safePending = Math.max(0.25, Number(pendingScale) || 1)
  const safeEpsilon = Math.max(0, Number(epsilon) || 0)
  return Math.abs(safeDisplayed - safePending) <= safeEpsilon
}

// 只缩放裁剪框里面的内容层：框本身保持铺满，超宽画布才能填住左右。
export const applyHorizontalBrowseLiveTempoPreviewTransform = (
  scalers: Array<HTMLElement | null | undefined>,
  displayedRate: number,
  targetRate: number | null | undefined
) => {
  const scaleX = resolveHorizontalBrowseLiveTempoPreviewScaleX(displayedRate, targetRate)
  // 归零时保留 transform（恒等 scale3d(1,1,1)）而不移除：移除会让元素从 3D 合成层退回普通层，
  // 触发图层销毁+重新光栅化。视觉与无变换完全等价，但图层生命周期稳定。
  // 注：曾试过“稳态撤掉 will-change 以减少常驻合成层”，真机无效（松手卡顿依旧），已回退。
  // 松手卡顿的真根因是 promote 时超宽合成层的一次性重合成（GPU 合成带宽），见
  // drafts/intermittent-bugs/horizontal-browse-live-tempo-release-jitter.md。
  const safeScaleX = Math.abs(scaleX - 1) > 0.0001 ? scaleX : 1
  const transform = `scale3d(${safeScaleX}, 1, 1)`

  for (const scaler of scalers) {
    if (!scaler) continue
    scaler.style.transformOrigin = LIVE_TEMPO_ORIGIN
    scaler.style.transform = transform
    scaler.style.willChange = 'transform'
  }
}
