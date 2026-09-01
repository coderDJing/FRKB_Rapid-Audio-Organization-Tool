import { describe, expect, it } from 'vitest'
import { resolveHorizontalBrowseStableOverscanCssPx } from './horizontalBrowseCanvasGeometry'

// overscan 是 stable canvas 的左右缓冲区：拖动/滚动时靠它填住视口两侧，不够就会漏出空波形。
// 曾为压低松手合成卡顿把位图上限降到 4096，真机确认会漏空波形，已恢复原始 15360。
// 这里锁住“overscan 必须显著大于视口宽”这一可用性底线，防止再为性能牺牲覆盖范围。
// 见 drafts/intermittent-bugs/horizontal-browse-live-tempo-release-jitter.md。
describe('resolveHorizontalBrowseStableOverscanCssPx overscan 覆盖底线', () => {
  it.each([
    { width: 640, dpr: 1 },
    { width: 965, dpr: 1.75 },
    { width: 1280, dpr: 1.5 },
    { width: 1920, dpr: 2 }
  ])('overscan 至少覆盖一个视口宽，避免拖动漏出空波形 (w=$width dpr=$dpr)', ({ width, dpr }) => {
    const overscanCssPx = resolveHorizontalBrowseStableOverscanCssPx(width, dpr)
    expect(overscanCssPx).toBeGreaterThanOrEqual(width)
  })

  it('overscan 非负且有下限，极窄视口也不为 0', () => {
    expect(resolveHorizontalBrowseStableOverscanCssPx(10, 1)).toBeGreaterThan(0)
    expect(resolveHorizontalBrowseStableOverscanCssPx(0, 0)).toBeGreaterThanOrEqual(0)
  })
})
