import { describe, expect, it } from 'vitest'
import {
  applyHorizontalBrowseLiveTempoPreviewTransform,
  resolveHorizontalBrowseLiveTempoPreviewReleasePlan,
  resolveHorizontalBrowseLiveTempoPreviewScaleX,
  resolveHorizontalBrowseLiveTempoPreviewVisualGeometry,
  shouldFinishHorizontalBrowseLiveTempoPreviewRelease
} from './horizontalBrowseLiveTempoPreview'

const createSurface = () => {
  const style: Record<string, string> = {}
  return {
    style: {
      set transformOrigin(value: string) {
        style.transformOrigin = value
      },
      get transformOrigin() {
        return style.transformOrigin || ''
      },
      set transform(value: string) {
        style.transform = value
      },
      get transform() {
        return style.transform || ''
      },
      set willChange(value: string) {
        style.willChange = value
      },
      get willChange() {
        return style.willChange || ''
      },
      removeProperty(name: string) {
        const camel = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
        delete style[camel]
      }
    }
  } as unknown as HTMLElement
}

describe('horizontalBrowseLiveTempoPreview', () => {
  it('目标更快时压缩已绘制内容，原点在播放头', () => {
    expect(resolveHorizontalBrowseLiveTempoPreviewScaleX(1, 1.1)).toBeCloseTo(0.909, 3)
    const surface = createSurface()
    applyHorizontalBrowseLiveTempoPreviewTransform([surface], 1, 1.1)
    expect(surface.style.transformOrigin).toBe('50% 50%')
    expect(surface.style.transform).toContain('scale3d(')
    expect(surface.style.transform).toContain('0.909')
  })

  it('显示倍率已经等于目标时清掉 transform', () => {
    const surface = createSurface()
    applyHorizontalBrowseLiveTempoPreviewTransform([surface], 1, 1.1)
    applyHorizontalBrowseLiveTempoPreviewTransform([surface], 1.1, 1.1)
    expect(surface.style.transform).toBe('')
    expect(surface.style.willChange).toBe('')
  })
})

describe('horizontalBrowseLiveTempoPreview 松手离场归位', () => {
  it('displayed 已在目标密度时立即归位', () => {
    const plan = resolveHorizontalBrowseLiveTempoPreviewReleasePlan(1.1, 1.1)
    expect(plan.mode).toBe('immediate')
    expect(plan.pendingScale).toBeCloseTo(1.1, 6)
  })

  it('displayed 仍停在旧密度时延迟归位，pendingScale 钉在提交目标', () => {
    // 拖动中 displayed 停在 1（旧），松手目标是 1.2（新）：必须延迟归位，否则会弹回。
    const plan = resolveHorizontalBrowseLiveTempoPreviewReleasePlan(1, 1.2)
    expect(plan.mode).toBe('deferred')
    expect(plan.pendingScale).toBeCloseTo(1.2, 6)
  })

  it('延迟归位期间：displayed 未追上目标不归零，追上后才归零', () => {
    const pending = 1.2
    // worker 中间帧：displayed 还在半路（1.0 / 1.1），保持拉伸态。
    expect(shouldFinishHorizontalBrowseLiveTempoPreviewRelease(1.0, pending)).toBe(false)
    expect(shouldFinishHorizontalBrowseLiveTempoPreviewRelease(1.1, pending)).toBe(false)
    // 新密度帧上屏：displayed 追上目标，归零。
    expect(shouldFinishHorizontalBrowseLiveTempoPreviewRelease(1.2, pending)).toBe(true)
  })

  it('pendingScale 为 null（非离场态）时不触发归零', () => {
    expect(shouldFinishHorizontalBrowseLiveTempoPreviewRelease(1.2, null)).toBe(false)
  })

  it('延迟归位全流程：拉伸态维持到新帧，scaleX 收敛到 1 无中途弹回', () => {
    const target = 1.2
    // 松手瞬间：displayed=1（旧），scaleX≠1，保持拉伸，视觉不弹回。
    expect(resolveHorizontalBrowseLiveTempoPreviewScaleX(1, target)).toBeCloseTo(0.833, 3)
    // worker 逐步逼近，scaleX 单调趋近 1，不出现回到 1（弹回旧密度）再变的情况。
    expect(resolveHorizontalBrowseLiveTempoPreviewScaleX(1.1, target)).toBeCloseTo(0.917, 3)
    // 新帧 ready：displayed==target，归位判定通过，scaleX==1。
    expect(shouldFinishHorizontalBrowseLiveTempoPreviewRelease(target, target)).toBe(true)
    expect(resolveHorizontalBrowseLiveTempoPreviewScaleX(target, target)).toBeCloseTo(1, 6)
  })
})

describe('horizontalBrowseLiveTempoPreview CSS 后视觉几何', () => {
  it.each([
    {
      renderedViewportStartSec: 3.4035,
      targetVisibleDurationSec: 10.8962,
      renderedTimeScale: 0.7855,
      targetTimeScale: 0.908,
      cssScaleX: 0.7855 / 0.908,
      expectedViewportStartSec: 2.6685,
      expectedPlayheadSec: 8.1166
    },
    {
      renderedViewportStartSec: 3.9951,
      targetVisibleDurationSec: 8.9152,
      renderedTimeScale: 0.908,
      targetTimeScale: 0.7429,
      cssScaleX: 0.908 / 0.7429,
      expectedViewportStartSec: 4.9857,
      expectedPlayheadSec: 9.4433
    }
  ])('把旧密度帧和 CSS scale 换算到用户实际看到的时间线', (sample) => {
    const geometry = resolveHorizontalBrowseLiveTempoPreviewVisualGeometry(sample)
    expect(geometry.effectiveViewportStartSec).toBeCloseTo(sample.expectedViewportStartSec, 4)
    expect(geometry.effectivePlayheadSec).toBeCloseTo(sample.expectedPlayheadSec, 4)
    expect(geometry.effectiveVisibleDurationSec).toBeCloseTo(sample.targetVisibleDurationSec, 6)
  })
})
