// 把「渲染范围 + 块池状态」编排成一份可直接执行的分块渲染计划：
// 每块画到哪个 slot、覆盖哪段时间、放在容器里的哪个 x、优先级如何、这一轮是否需要重画。
//
// 几何全部来自 horizontalBrowseWaveformTileLayout 的全局网格，复用判定全部来自
// horizontalBrowseWaveformTilePool。本模块只做编排，不碰 DOM、不碰 canvas。
//
// ## 块容器与旧超宽 canvas 的几何等价
//
// 块容器的 left / width 与旧的单张超宽 canvas **完全一致**（left = -overscan, width = renderWidth），
// 容器的 translate 也仍是旧的 presentation offset。这样：
//   - `resolveHorizontalBrowseRenderedCanvasViewportStartSec` 的反解公式无需改动；
//   - `resolveHorizontalBrowseStableCanvasOffsetCssPx` 的 offset 语义无需改动；
//   - `.tempo-scaler` 仍挂在容器之上（每块不独立缩放，避免边界亚像素错位）。
//
// 代价是块会在容器左右边缘各溢出不足一块——全局网格的边界不会正好落在渲染范围端点上。
// 溢出无害：`__surface` 本身 overflow:hidden，可见区之外一律裁掉。
// 因此块的 leftCssPx 要减去 containerOffsetCssPx，把「容器原点」换算回「网格原点」。
//
// 见 drafts/大波形分块瓦片渲染设计.md。
import {
  HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE,
  resolveHorizontalBrowseWaveformTileCoverage,
  resolveHorizontalBrowseWaveformTileGrid,
  resolveHorizontalBrowseWaveformTilePriorities,
  type HorizontalBrowseWaveformTileGrid,
  type HorizontalBrowseWaveformTilePriority
} from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformTileLayout'
import type {
  createHorizontalBrowseWaveformTilePool,
  HorizontalBrowseWaveformTileGeneration
} from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformTilePool'

export type HorizontalBrowseWaveformTilePool = ReturnType<
  typeof createHorizontalBrowseWaveformTilePool
>

export type HorizontalBrowseWaveformTilePlanTile = {
  globalIndex: number
  /** 该块画到块池的哪个 slot（= 第几个 tile canvas）。 */
  slotIndex: number
  /** 块在容器坐标下的左边缘。已扣除 containerOffsetCssPx，可直接写 style.left。 */
  leftCssPx: number
  widthCssPx: number
  /** 块位图物理像素宽。worker 直接用它设 canvas.width，避免二次取整。 */
  scaledWidth: number
  rangeStartSec: number
  rangeDurationSec: number
  priority: HorizontalBrowseWaveformTilePriority
  /** false = 该 slot 已持有本代同块内容，按几何平移复用，本轮无需重画。 */
  needsRender: boolean
}

export type HorizontalBrowseWaveformTilePlan = {
  grid: HorizontalBrowseWaveformTileGrid
  /** 块位图物理像素高，所有块相同。 */
  scaledHeight: number
  containerOffsetCssPx: number
  tiles: HorizontalBrowseWaveformTilePlanTile[]
  /** 可见区（P0）块的 slotIndex；这些块必须全部 ready 才允许切换可见面。 */
  visibleSlotIndexes: number[]
}

const resolveScaledHeight = (heightCssPx: number, pixelRatio: number) => {
  const numeric = Number(heightCssPx)
  const safeCssHeight =
    !Number.isFinite(numeric) || numeric <= 0 ? 1 : Math.max(1, Math.round(numeric * 1000) / 1000)
  return Math.max(1, Math.round(safeCssHeight * pixelRatio))
}

/**
 * 编排一轮分块渲染。
 *
 * `viewportStartCssPx` / `viewportWidthCssPx` 用渲染范围坐标（即 0 = 渲染范围左端、
 * overscan 的最左侧），内部会换算到容器坐标做优先级判定——调用方不需要关心 containerOffset。
 *
 * `forward` 表示播放 / 拖动前进方向，决定屏幕外块 P1 / P2 的分配。
 */
export const resolveHorizontalBrowseWaveformTileRenderPlan = ({
  renderWidthCssPx,
  heightCssPx,
  pixelRatio,
  rangeStartSec,
  rangeDurationSec,
  viewportStartCssPx,
  viewportWidthCssPx,
  generation,
  pool,
  forward = true,
  tileCount
}: {
  renderWidthCssPx: number
  heightCssPx: number
  pixelRatio: number
  rangeStartSec: number
  rangeDurationSec: number
  viewportStartCssPx: number
  viewportWidthCssPx: number
  generation: HorizontalBrowseWaveformTileGeneration
  pool: HorizontalBrowseWaveformTilePool
  forward?: boolean
  tileCount?: number
}): HorizontalBrowseWaveformTilePlan => {
  const grid = resolveHorizontalBrowseWaveformTileGrid({
    renderWidthCssPx,
    pixelRatio,
    tileCount
  })
  const coverage = resolveHorizontalBrowseWaveformTileCoverage({
    grid,
    rangeStartSec,
    rangeDurationSec
  })
  const priorities = resolveHorizontalBrowseWaveformTilePriorities({
    tiles: coverage.tiles,
    // 渲染范围坐标 → 容器坐标：容器原点在渲染范围起点左侧 containerOffsetCssPx 处。
    viewportStartCssPx: Number(viewportStartCssPx) + coverage.containerOffsetCssPx,
    viewportWidthCssPx,
    forward
  })

  // 回收参照点取可见区所在的全局块，使回收优先淘汰离可见区最远的块。
  const visibleCoverageIndex = priorities.indexOf(HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE)
  const viewportGlobalIndex =
    visibleCoverageIndex >= 0 ? coverage.tiles[visibleCoverageIndex].globalIndex : undefined

  const assignments = pool.assign({
    globalIndexes: coverage.tiles.map((tile) => tile.globalIndex),
    generation,
    viewportGlobalIndex
  })
  const assignmentByGlobalIndex = new Map(
    assignments.map((assignment) => [assignment.globalIndex, assignment] as const)
  )

  const tiles: HorizontalBrowseWaveformTilePlanTile[] = []
  coverage.tiles.forEach((tile, coverageIndex) => {
    const assignment = assignmentByGlobalIndex.get(tile.globalIndex)
    // 块池 slot 不足时该块拿不到画布。此处只能跳过；上层据 visibleSlotIndexes 判断可见区是否齐全，
    // 可见区缺块时不切换可见面（架构标准禁止可见区出现空白）。
    if (!assignment) return
    tiles.push({
      globalIndex: tile.globalIndex,
      slotIndex: assignment.slotIndex,
      leftCssPx: tile.leftCssPx - coverage.containerOffsetCssPx,
      widthCssPx: tile.widthCssPx,
      scaledWidth: tile.scaledWidth,
      rangeStartSec: tile.rangeStartSec,
      rangeDurationSec: tile.rangeDurationSec,
      priority: priorities[coverageIndex],
      needsRender: !assignment.reused
    })
  })

  return {
    grid,
    scaledHeight: resolveScaledHeight(heightCssPx, grid.pixelRatio),
    containerOffsetCssPx: coverage.containerOffsetCssPx,
    tiles,
    visibleSlotIndexes: tiles
      .filter((tile) => tile.priority === HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE)
      .map((tile) => tile.slotIndex)
  }
}

/**
 * 按优先级排出实际渲染顺序：P0 → P1 → P2，同档内按时间先后。
 *
 * 只返回本轮需要重画的块。P0 必须先全部画完再动 P1 / P2，因为只有 P0 齐了才允许切换可见面。
 */
export const resolveHorizontalBrowseWaveformTileRenderOrder = (
  plan: HorizontalBrowseWaveformTilePlan
): HorizontalBrowseWaveformTilePlanTile[] =>
  plan.tiles
    .filter((tile) => tile.needsRender)
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority
      return left.globalIndex - right.globalIndex
    })
