import { describe, expect, it } from 'vitest'
import {
  resolveHorizontalBrowseWaveformTileRenderOrder,
  resolveHorizontalBrowseWaveformTileRenderPlan
} from './horizontalBrowseWaveformTilePlan'
import { createHorizontalBrowseWaveformTilePool } from './horizontalBrowseWaveformTilePool'
import {
  HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_BACKWARD,
  HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_FORWARD,
  HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE,
  resolveHorizontalBrowseWaveformTileGrid
} from './horizontalBrowseWaveformTileLayout'

// 渲染计划把「全局网格几何」与「块池复用」编排到一起。这里锁住三件事：
// 1. 块集合在容器坐标下完整覆盖可见区（不允许可见区出现无人负责的空洞）；
// 2. 平移只让缺口方向的块 needsRender；
// 3. 渲染顺序 P0 → P1 → P2。
// 见 drafts/大波形分块瓦片渲染设计.md。

// 真机几何：viewport ≈965 CSS px 居中于 ≈6756 CSS px 渲染宽（含左右对称 overscan），dpr 1.75。
const RENDER_WIDTH_CSS_PX = 6756
const HEIGHT_CSS_PX = 96
const PIXEL_RATIO = 1.75
const VIEWPORT_WIDTH_CSS_PX = 965
const VIEWPORT_START_CSS_PX = (RENDER_WIDTH_CSS_PX - VIEWPORT_WIDTH_CSS_PX) / 2
const RANGE_DURATION_SEC = 47.5
const GENERATION = { timeScale: 1, renderRevision: 4 }

const grid = resolveHorizontalBrowseWaveformTileGrid({
  renderWidthCssPx: RENDER_WIDTH_CSS_PX,
  pixelRatio: PIXEL_RATIO
})

const createPool = (extraSlots = 0) =>
  createHorizontalBrowseWaveformTilePool(grid.maxTileCount + extraSlots)

const resolvePlan = (
  pool: ReturnType<typeof createHorizontalBrowseWaveformTilePool>,
  rangeStartSec: number,
  overrides: { forward?: boolean; generation?: typeof GENERATION } = {}
) =>
  resolveHorizontalBrowseWaveformTileRenderPlan({
    renderWidthCssPx: RENDER_WIDTH_CSS_PX,
    heightCssPx: HEIGHT_CSS_PX,
    pixelRatio: PIXEL_RATIO,
    rangeStartSec,
    rangeDurationSec: RANGE_DURATION_SEC,
    viewportStartCssPx: VIEWPORT_START_CSS_PX,
    viewportWidthCssPx: VIEWPORT_WIDTH_CSS_PX,
    generation: overrides.generation ?? GENERATION,
    pool,
    forward: overrides.forward
  })

const commitPlan = (
  pool: ReturnType<typeof createHorizontalBrowseWaveformTilePool>,
  plan: ReturnType<typeof resolvePlan>,
  generation = GENERATION
) => {
  for (const tile of plan.tiles) {
    pool.markRendered(tile.slotIndex, generation, tile.globalIndex)
  }
}

describe('resolveHorizontalBrowseWaveformTileRenderPlan 几何', () => {
  it('块集合在容器坐标下完整覆盖整个渲染范围', () => {
    const plan = resolvePlan(createPool(), 30.137)
    expect(plan.tiles.length).toBeGreaterThanOrEqual(1)
    // 首块左缘不晚于渲染范围起点（0），末块右缘不早于渲染范围终点。
    expect(plan.tiles[0].leftCssPx).toBeLessThanOrEqual(0)
    const lastTile = plan.tiles[plan.tiles.length - 1]
    expect(lastTile.leftCssPx + lastTile.widthCssPx).toBeGreaterThanOrEqual(RENDER_WIDTH_CSS_PX)
  })

  it('相邻块在容器坐标下严格衔接，无缝隙无重叠', () => {
    const plan = resolvePlan(createPool(), 30.137)
    plan.tiles.forEach((tile, index) => {
      const nextTile = plan.tiles[index + 1]
      if (!nextTile) return
      expect(tile.leftCssPx + tile.widthCssPx).toBeCloseTo(nextTile.leftCssPx, 10)
      // 采样窗口同样必须严格衔接。
      expect(tile.rangeStartSec + tile.rangeDurationSec).toBe(nextTile.rangeStartSec)
    })
  })

  it('容器溢出量小于一块，且块位图尺寸是整数物理像素', () => {
    const plan = resolvePlan(createPool(), 30.137)
    expect(plan.containerOffsetCssPx).toBeGreaterThanOrEqual(0)
    expect(plan.containerOffsetCssPx).toBeLessThan(grid.tileWidthCssPx)
    expect(Number.isInteger(plan.scaledHeight)).toBe(true)
    for (const tile of plan.tiles) {
      expect(Number.isInteger(tile.scaledWidth)).toBe(true)
      expect(tile.scaledWidth).toBe(grid.tileScaledWidth)
    }
  })

  it('可见区被 P0 块完整覆盖', () => {
    const plan = resolvePlan(createPool(), 30.137)
    const visibleTiles = plan.tiles.filter(
      (tile) => tile.priority === HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE
    )
    expect(visibleTiles.length).toBeGreaterThanOrEqual(1)
    expect(visibleTiles.length).toBeLessThanOrEqual(2)
    expect(visibleTiles[0].leftCssPx).toBeLessThanOrEqual(VIEWPORT_START_CSS_PX)
    const lastVisibleTile = visibleTiles[visibleTiles.length - 1]
    expect(lastVisibleTile.leftCssPx + lastVisibleTile.widthCssPx).toBeGreaterThanOrEqual(
      VIEWPORT_START_CSS_PX + VIEWPORT_WIDTH_CSS_PX
    )
    expect(plan.visibleSlotIndexes).toEqual(visibleTiles.map((tile) => tile.slotIndex))
  })

  it('多 dpr 下容器坐标衔接与可见区覆盖均成立', () => {
    for (const pixelRatio of [1, 1.25, 1.5, 1.75, 2]) {
      const scopedGrid = resolveHorizontalBrowseWaveformTileGrid({
        renderWidthCssPx: RENDER_WIDTH_CSS_PX,
        pixelRatio
      })
      const pool = createHorizontalBrowseWaveformTilePool(scopedGrid.maxTileCount)
      const plan = resolveHorizontalBrowseWaveformTileRenderPlan({
        renderWidthCssPx: RENDER_WIDTH_CSS_PX,
        heightCssPx: HEIGHT_CSS_PX,
        pixelRatio,
        rangeStartSec: 30.137,
        rangeDurationSec: RANGE_DURATION_SEC,
        viewportStartCssPx: VIEWPORT_START_CSS_PX,
        viewportWidthCssPx: VIEWPORT_WIDTH_CSS_PX,
        generation: GENERATION,
        pool
      })
      plan.tiles.forEach((tile, index) => {
        const nextTile = plan.tiles[index + 1]
        if (nextTile) {
          expect(tile.leftCssPx + tile.widthCssPx).toBeCloseTo(nextTile.leftCssPx, 10)
        }
        // 每块左缘落在整数物理像素上（相对网格原点）。
        const gridRelativeScaledLeft = (tile.leftCssPx + plan.containerOffsetCssPx) * pixelRatio
        expect(Math.abs(gridRelativeScaledLeft - Math.round(gridRelativeScaledLeft))).toBeLessThan(
          1e-6
        )
      })
      expect(plan.visibleSlotIndexes.length).toBeGreaterThanOrEqual(1)
      const lastTile = plan.tiles[plan.tiles.length - 1]
      expect(lastTile.leftCssPx + lastTile.widthCssPx).toBeGreaterThanOrEqual(RENDER_WIDTH_CSS_PX)
    }
  })
})

describe('resolveHorizontalBrowseWaveformTileRenderPlan 复用', () => {
  it('首轮全块需要渲染', () => {
    const plan = resolvePlan(createPool(), 30)
    expect(plan.tiles.every((tile) => tile.needsRender)).toBe(true)
  })

  it('同代同位置再算一次时全块复用', () => {
    const pool = createPool()
    commitPlan(pool, resolvePlan(pool, 30))
    const secondPlan = resolvePlan(pool, 30)
    expect(secondPlan.tiles.every((tile) => !tile.needsRender)).toBe(true)
    expect(resolveHorizontalBrowseWaveformTileRenderOrder(secondPlan)).toHaveLength(0)
  })

  it('改变时间密度（timeScale）后全块需要重画', () => {
    const pool = createPool()
    commitPlan(pool, resolvePlan(pool, 30))
    const nextGeneration = { timeScale: 1.06, renderRevision: 4 }
    const plan = resolvePlan(pool, 30, { generation: nextGeneration })
    expect(plan.tiles.every((tile) => tile.needsRender)).toBe(true)
  })

  it('平移一块后只有一块需要重画', () => {
    const pool = createPool(2)
    const basePlan = resolvePlan(pool, 30)
    commitPlan(pool, basePlan)
    const tileDurationSec = basePlan.tiles[0].rangeDurationSec
    const shiftedPlan = resolvePlan(pool, 30 + tileDurationSec)
    const freshTiles = shiftedPlan.tiles.filter((tile) => tile.needsRender)
    expect(freshTiles).toHaveLength(1)
  })

  it('亚像素平移不触发全量重画', () => {
    const pool = createPool(2)
    commitPlan(pool, resolvePlan(pool, 30))
    const plan = resolvePlan(pool, 30.001)
    const freshCount = plan.tiles.filter((tile) => tile.needsRender).length
    expect(freshCount).toBeLessThanOrEqual(1)
  })
})

describe('resolveHorizontalBrowseWaveformTileRenderOrder 优先级顺序', () => {
  it('先 P0 再 P1 最后 P2，同档内按时间先后', () => {
    const order = resolveHorizontalBrowseWaveformTileRenderOrder(resolvePlan(createPool(), 30))
    expect(order.length).toBeGreaterThan(0)
    order.forEach((tile, index) => {
      const nextTile = order[index + 1]
      if (!nextTile) return
      expect(tile.priority).toBeLessThanOrEqual(nextTile.priority)
      if (tile.priority === nextTile.priority) {
        expect(tile.globalIndex).toBeLessThan(nextTile.globalIndex)
      }
    })
    // 队首必须是可见区块——先画用户看得见的那几块，这是分块方案的全部收益来源。
    expect(order[0].priority).toBe(HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE)
  })

  it('前向 overscan 排在后向之前，反向拖动时互换', () => {
    const forwardOrder = resolveHorizontalBrowseWaveformTileRenderOrder(
      resolvePlan(createPool(), 30, { forward: true })
    )
    const forwardTail = forwardOrder.filter(
      (tile) => tile.priority !== HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE
    )
    expect(forwardTail[0].priority).toBe(HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_FORWARD)
    // 前向块必然位于可见区右侧。
    expect(forwardTail[0].leftCssPx).toBeGreaterThan(VIEWPORT_START_CSS_PX)

    const backwardOrder = resolveHorizontalBrowseWaveformTileRenderOrder(
      resolvePlan(createPool(), 30, { forward: false })
    )
    const backwardTail = backwardOrder.filter(
      (tile) => tile.priority !== HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE
    )
    expect(backwardTail[0].priority).toBe(HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_FORWARD)
    // 反向时「前向」指向可见区左侧。
    expect(backwardTail[0].leftCssPx).toBeLessThan(VIEWPORT_START_CSS_PX)
  })

  it('slot 不足时可见区块数会少于覆盖需求，上层据此判定不可切面', () => {
    const pool = createHorizontalBrowseWaveformTilePool(1)
    const plan = resolveHorizontalBrowseWaveformTileRenderPlan({
      renderWidthCssPx: RENDER_WIDTH_CSS_PX,
      heightCssPx: HEIGHT_CSS_PX,
      pixelRatio: PIXEL_RATIO,
      rangeStartSec: 30,
      rangeDurationSec: RANGE_DURATION_SEC,
      viewportStartCssPx: VIEWPORT_START_CSS_PX,
      viewportWidthCssPx: VIEWPORT_WIDTH_CSS_PX,
      generation: GENERATION,
      pool
    })
    expect(plan.tiles).toHaveLength(1)
    // 覆盖不全时不会假装可见区已齐。
    const lastTile = plan.tiles[plan.tiles.length - 1]
    expect(lastTile.leftCssPx + lastTile.widthCssPx).toBeLessThan(RENDER_WIDTH_CSS_PX)
  })
})
