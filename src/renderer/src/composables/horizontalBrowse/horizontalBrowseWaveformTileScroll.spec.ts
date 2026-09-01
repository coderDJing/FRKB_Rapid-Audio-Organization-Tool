import { describe, expect, it } from 'vitest'
import {
  resolveHorizontalBrowseWaveformTileRenderOrder,
  resolveHorizontalBrowseWaveformTileRenderPlan
} from './horizontalBrowseWaveformTilePlan'
import { createHorizontalBrowseWaveformTilePool } from './horizontalBrowseWaveformTilePool'
import {
  HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE,
  HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT,
  resolveHorizontalBrowseWaveformTileGrid
} from './horizontalBrowseWaveformTileLayout'
import { resolveHorizontalBrowseStableOverscanCssPx } from './horizontalBrowseCanvasGeometry'

// 阶段 3 / 4 的行为验收（可自动化的部分）：
// - 播放滚动必须持续复用块，不能每帧全量重画（否则分块比旧路径更慢）；
// - 任意滚动位置下可见区都必须被 P0 块完整覆盖（一票否决项：可见区不得空白）；
// - 块池容量必须够用，否则会出现「可见区拿不到画布」；
// - 屏幕外块永远排在可见区块之后（P0 优先，才有「先画看得见的那几块」的收益）。
// 见 drafts/大波形分块瓦片渲染设计.md。

const VIEWPORT_WIDTH_CSS_PX = 965
const PIXEL_RATIO = 1.75
const HEIGHT_CSS_PX = 96
const RANGE_DURATION_SEC = 47.5
const GENERATION = { timeScale: 1, renderRevision: 4 }

// 与真机一致地由 overscan 推出渲染宽，避免测试用臆造的几何。
const OVERSCAN_CSS_PX = resolveHorizontalBrowseStableOverscanCssPx(
  VIEWPORT_WIDTH_CSS_PX,
  PIXEL_RATIO
)
const RENDER_WIDTH_CSS_PX = VIEWPORT_WIDTH_CSS_PX + OVERSCAN_CSS_PX * 2

const grid = resolveHorizontalBrowseWaveformTileGrid({
  renderWidthCssPx: RENDER_WIDTH_CSS_PX,
  pixelRatio: PIXEL_RATIO
})

const resolvePlan = (
  pool: ReturnType<typeof createHorizontalBrowseWaveformTilePool>,
  rangeStartSec: number,
  forward = true
) =>
  resolveHorizontalBrowseWaveformTileRenderPlan({
    renderWidthCssPx: RENDER_WIDTH_CSS_PX,
    heightCssPx: HEIGHT_CSS_PX,
    pixelRatio: PIXEL_RATIO,
    rangeStartSec,
    rangeDurationSec: RANGE_DURATION_SEC,
    viewportStartCssPx: OVERSCAN_CSS_PX,
    viewportWidthCssPx: VIEWPORT_WIDTH_CSS_PX,
    generation: GENERATION,
    pool,
    forward
  })

// 模拟 worker 回报：只把「本轮计划要画的块」标记为已画。
const commitPlan = (
  pool: ReturnType<typeof createHorizontalBrowseWaveformTilePool>,
  plan: ReturnType<typeof resolvePlan>
) => {
  for (const tile of plan.tiles) {
    if (!tile.needsRender) continue
    pool.markRendered(tile.slotIndex, GENERATION, tile.globalIndex)
  }
}

describe('分块路径的块池容量', () => {
  it('固定 slot 数足以覆盖真机渲染宽，可见区不会拿不到画布', () => {
    expect(grid.maxTileCount).toBeLessThanOrEqual(HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT)
    const pool = createHorizontalBrowseWaveformTilePool(HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT)
    const plan = resolvePlan(pool, 30)
    // 每个覆盖块都拿到了 slot（计划块数 === 覆盖需求）。
    expect(plan.tiles.length).toBe(grid.maxTileCount)
    const lastTile = plan.tiles[plan.tiles.length - 1]
    expect(lastTile.leftCssPx + lastTile.widthCssPx).toBeGreaterThanOrEqual(RENDER_WIDTH_CSS_PX)
  })

  it('多 dpr 下 slot 数都够用', () => {
    for (const pixelRatio of [1, 1.25, 1.5, 1.75, 2]) {
      const overscanCssPx = resolveHorizontalBrowseStableOverscanCssPx(
        VIEWPORT_WIDTH_CSS_PX,
        pixelRatio
      )
      const scopedGrid = resolveHorizontalBrowseWaveformTileGrid({
        renderWidthCssPx: VIEWPORT_WIDTH_CSS_PX + overscanCssPx * 2,
        pixelRatio
      })
      expect(scopedGrid.maxTileCount).toBeLessThanOrEqual(
        HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT
      )
    }
  })
})

describe('播放滚动的块复用（阶段 3）', () => {
  it('连续滚动稳态下每轮最多重画一块', () => {
    const pool = createHorizontalBrowseWaveformTilePool(HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT)
    let rangeStartSec = 30
    commitPlan(pool, resolvePlan(pool, rangeStartSec))
    const tileDurationSec = grid.tileScaledWidth / (grid.totalScaledWidth / RANGE_DURATION_SEC)

    // 以「每步四分之一块」的细粒度推进，模拟播放滚动。
    const stepSec = tileDurationSec / 4
    const freshCounts: number[] = []
    for (let step = 0; step < 24; step += 1) {
      rangeStartSec += stepSec
      const plan = resolvePlan(pool, rangeStartSec)
      freshCounts.push(plan.tiles.filter((tile) => tile.needsRender).length)
      commitPlan(pool, plan)
    }
    // 稳态下绝大多数帧无需重画，跨块边界那一帧只补一块。
    expect(Math.max(...freshCounts)).toBeLessThanOrEqual(1)
    expect(freshCounts.filter((count) => count === 0).length).toBeGreaterThan(
      freshCounts.length / 2
    )
  })

  it('滚动全程可见区都被 P0 块完整覆盖', () => {
    const pool = createHorizontalBrowseWaveformTilePool(HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT)
    const tileDurationSec = grid.tileScaledWidth / (grid.totalScaledWidth / RANGE_DURATION_SEC)
    let rangeStartSec = 30
    for (let step = 0; step < 40; step += 1) {
      const plan = resolvePlan(pool, rangeStartSec)
      const visibleTiles = plan.tiles.filter(
        (tile) => tile.priority === HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE
      )
      expect(visibleTiles.length).toBeGreaterThanOrEqual(1)
      // 可见区左右边缘都必须落在 P0 块之内。
      const firstVisible = visibleTiles[0]
      const lastVisible = visibleTiles[visibleTiles.length - 1]
      expect(firstVisible.leftCssPx).toBeLessThanOrEqual(OVERSCAN_CSS_PX + 1e-9)
      expect(lastVisible.leftCssPx + lastVisible.widthCssPx).toBeGreaterThanOrEqual(
        OVERSCAN_CSS_PX + VIEWPORT_WIDTH_CSS_PX - 1e-9
      )
      // P0 块必须连续，中间不能夹着非 P0 块。
      const visibleIndexes = plan.tiles
        .map((tile, index) => ({ tile, index }))
        .filter(({ tile }) => tile.priority === HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE)
        .map(({ index }) => index)
      for (let cursor = 1; cursor < visibleIndexes.length; cursor += 1) {
        expect(visibleIndexes[cursor]).toBe(visibleIndexes[cursor - 1] + 1)
      }
      commitPlan(pool, plan)
      rangeStartSec += tileDurationSec / 3
    }
  })

  it('反向拖动同样只需增量补块，不触发全量重画', () => {
    const pool = createHorizontalBrowseWaveformTilePool(HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT)
    const tileDurationSec = grid.tileScaledWidth / (grid.totalScaledWidth / RANGE_DURATION_SEC)
    let rangeStartSec = 300
    commitPlan(pool, resolvePlan(pool, rangeStartSec, false))
    for (let step = 0; step < 12; step += 1) {
      rangeStartSec -= tileDurationSec / 3
      const plan = resolvePlan(pool, rangeStartSec, false)
      expect(plan.tiles.filter((tile) => tile.needsRender).length).toBeLessThanOrEqual(1)
      commitPlan(pool, plan)
    }
  })
})

describe('优先级调度（阶段 4）', () => {
  it('待画队列里可见区块永远排在屏幕外块之前', () => {
    const pool = createHorizontalBrowseWaveformTilePool(HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT)
    const order = resolveHorizontalBrowseWaveformTileRenderOrder(resolvePlan(pool, 30))
    const firstOffscreenAt = order.findIndex(
      (tile) => tile.priority !== HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE
    )
    const lastVisibleAt = order.reduce(
      (result, tile, index) =>
        tile.priority === HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE ? index : result,
      -1
    )
    expect(lastVisibleAt).toBeGreaterThanOrEqual(0)
    if (firstOffscreenAt >= 0) expect(firstOffscreenAt).toBeGreaterThan(lastVisibleAt)
  })

  it('首屏必须等的块数远小于总块数——这是分块的收益来源', () => {
    const pool = createHorizontalBrowseWaveformTilePool(HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT)
    const plan = resolvePlan(pool, 30)
    const visibleCount = plan.visibleSlotIndexes.length
    // 真机几何下可见区仅占渲染面积约 14%，对应 1~2 块。
    expect(visibleCount).toBeLessThanOrEqual(2)
    expect(visibleCount / plan.tiles.length).toBeLessThan(0.35)
  })
})
