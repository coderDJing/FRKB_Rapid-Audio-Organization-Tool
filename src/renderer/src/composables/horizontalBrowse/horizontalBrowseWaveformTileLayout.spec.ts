import { describe, expect, it } from 'vitest'
import {
  HORIZONTAL_BROWSE_WAVEFORM_TILE_COUNT,
  HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_BACKWARD,
  HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_FORWARD,
  HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE,
  resolveHorizontalBrowseWaveformTileCoverage,
  resolveHorizontalBrowseWaveformTileGrid,
  resolveHorizontalBrowseWaveformTilePriorities
} from './horizontalBrowseWaveformTileLayout'

// 分块的最高风险是接缝：块边界没落在整数物理像素、或各块独立取整导致累积漂移，都会在高 DPI 下
// 表现为缝隙或 1px 错位。这组用例锁住「相邻块严格衔接」「块宽恒定」「平移不变性」三条防线。
// 见 drafts/大波形分块瓦片渲染设计.md。

// 覆盖真机 dpr（1.75 为实测值）与视口宽 / 含 overscan 渲染宽 / 位图上限附近三档。
const PIXEL_RATIOS = [1, 1.25, 1.5, 1.75, 2]
const RENDER_WIDTHS_CSS_PX = [965, 6756, 12000]

describe('resolveHorizontalBrowseWaveformTileGrid 全局网格', () => {
  for (const pixelRatio of PIXEL_RATIOS) {
    for (const renderWidthCssPx of RENDER_WIDTHS_CSS_PX) {
      it(`块宽是整数物理像素，覆盖一屏不超过 块数+1 (w=${renderWidthCssPx} dpr=${pixelRatio})`, () => {
        const grid = resolveHorizontalBrowseWaveformTileGrid({ renderWidthCssPx, pixelRatio })
        expect(Number.isInteger(grid.tileScaledWidth)).toBe(true)
        expect(grid.tileScaledWidth).toBeGreaterThanOrEqual(1)
        expect(Math.round(grid.tileWidthCssPx * grid.pixelRatio)).toBe(grid.tileScaledWidth)
        // 「+1」是两端不完整块带来的那一块；块池按 maxTileCount 分配 slot 后不会再增长。
        expect(grid.maxTileCount).toBeLessThanOrEqual(HORIZONTAL_BROWSE_WAVEFORM_TILE_COUNT + 1)
        // 块宽 × 块数必须真的盖住整张位图，否则右端会漏出未画区域。
        expect(grid.tileScaledWidth * HORIZONTAL_BROWSE_WAVEFORM_TILE_COUNT).toBeGreaterThanOrEqual(
          grid.totalScaledWidth
        )
      })
    }
  }

  it('非法尺寸与 pixelRatio 降级为安全值，不抛错', () => {
    const grid = resolveHorizontalBrowseWaveformTileGrid({ renderWidthCssPx: 0, pixelRatio: 0 })
    expect(grid.pixelRatio).toBe(1)
    expect(grid.totalScaledWidth).toBeGreaterThanOrEqual(1)
    expect(grid.tileScaledWidth).toBeGreaterThanOrEqual(1)
  })
})

describe('resolveHorizontalBrowseWaveformTileCoverage 接缝防线', () => {
  for (const pixelRatio of PIXEL_RATIOS) {
    for (const renderWidthCssPx of RENDER_WIDTHS_CSS_PX) {
      it(`相邻块严格衔接且块宽恒定 (w=${renderWidthCssPx} dpr=${pixelRatio})`, () => {
        const grid = resolveHorizontalBrowseWaveformTileGrid({ renderWidthCssPx, pixelRatio })
        const coverage = resolveHorizontalBrowseWaveformTileCoverage({
          grid,
          rangeStartSec: 30.137,
          rangeDurationSec: 47.5
        })
        expect(coverage.tiles.length).toBeLessThanOrEqual(grid.maxTileCount)
        expect(coverage.tiles.length).toBeGreaterThanOrEqual(1)

        coverage.tiles.forEach((tile, index) => {
          // 块宽恒定：这是平移不变性的前提，也让相邻块永不出现半像素缝。
          expect(tile.scaledWidth).toBe(grid.tileScaledWidth)
          expect(Number.isInteger(tile.scaledLeft)).toBe(true)
          expect(Math.round(tile.leftCssPx * grid.pixelRatio)).toBe(tile.scaledLeft)
          const nextTile = coverage.tiles[index + 1]
          if (nextTile) {
            expect(tile.scaledLeft + tile.scaledWidth).toBe(nextTile.scaledLeft)
            expect(tile.globalIndex + 1).toBe(nextTile.globalIndex)
            // 采样窗口衔接：严格相等（同一表达式求得），不是「接近」。
            expect(tile.rangeEndSec).toBe(nextTile.rangeStartSec)
          }
        })
      })

      it(`块集合完整覆盖渲染范围，两端无漏画 (w=${renderWidthCssPx} dpr=${pixelRatio})`, () => {
        const grid = resolveHorizontalBrowseWaveformTileGrid({ renderWidthCssPx, pixelRatio })
        const rangeStartSec = 30.137
        const rangeDurationSec = 47.5
        const coverage = resolveHorizontalBrowseWaveformTileCoverage({
          grid,
          rangeStartSec,
          rangeDurationSec
        })
        // 容器原点在渲染范围起点左侧 containerOffsetScaledPx 处，覆盖范围必须包住整张位图。
        expect(coverage.containerOffsetScaledPx).toBeGreaterThanOrEqual(0)
        expect(coverage.containerOffsetScaledPx).toBeLessThan(grid.tileScaledWidth)
        const coveredScaledWidth = coverage.tiles.length * grid.tileScaledWidth
        expect(coveredScaledWidth - coverage.containerOffsetScaledPx).toBeGreaterThanOrEqual(
          grid.totalScaledWidth
        )
        // 时间上同样包住：首块不晚于范围起点，末块不早于范围结束。
        expect(coverage.tiles[0].rangeStartSec).toBeLessThanOrEqual(rangeStartSec + 1e-9)
        const lastTile = coverage.tiles[coverage.tiles.length - 1]
        expect(lastTile.rangeEndSec).toBeGreaterThanOrEqual(rangeStartSec + rangeDurationSec - 1e-9)
      })
    }
  }

  // 平移不变性是滚动复用的全部前提：若块边界随位图位置漂移，平移后没有一块能命中上一轮结果，
  // 阶段 3 的「块复用」收益会整体归零。
  it('平移整数块后，重叠部分的 globalIndex 与时间边界逐位不变', () => {
    const grid = resolveHorizontalBrowseWaveformTileGrid({
      renderWidthCssPx: 6756,
      pixelRatio: 1.75
    })
    const rangeDurationSec = 47.5
    const baseCoverage = resolveHorizontalBrowseWaveformTileCoverage({
      grid,
      rangeStartSec: 30,
      rangeDurationSec
    })
    const tileDurationSec = baseCoverage.tiles[0].rangeDurationSec
    const shiftedCoverage = resolveHorizontalBrowseWaveformTileCoverage({
      grid,
      rangeStartSec: 30 + tileDurationSec * 2,
      rangeDurationSec
    })
    const baseByGlobalIndex = new Map(
      baseCoverage.tiles.map((tile) => [tile.globalIndex, tile] as const)
    )
    const overlappingTiles = shiftedCoverage.tiles.filter((tile) =>
      baseByGlobalIndex.has(tile.globalIndex)
    )
    // 平移两块后仍应有大量块重合，而不是全部错开。
    expect(overlappingTiles.length).toBeGreaterThanOrEqual(baseCoverage.tiles.length - 3)
    for (const tile of overlappingTiles) {
      const baseTile = baseByGlobalIndex.get(tile.globalIndex)!
      expect(tile.rangeStartSec).toBe(baseTile.rangeStartSec)
      expect(tile.rangeEndSec).toBe(baseTile.rangeEndSec)
      expect(tile.scaledWidth).toBe(baseTile.scaledWidth)
    }
  })

  it('任意亚像素平移下块边界仍锚定同一全局网格', () => {
    const grid = resolveHorizontalBrowseWaveformTileGrid({
      renderWidthCssPx: 6756,
      pixelRatio: 1.75
    })
    const rangeDurationSec = 47.5
    const firstCoverage = resolveHorizontalBrowseWaveformTileCoverage({
      grid,
      rangeStartSec: 30,
      rangeDurationSec
    })
    const secondCoverage = resolveHorizontalBrowseWaveformTileCoverage({
      grid,
      rangeStartSec: 30.013,
      rangeDurationSec
    })
    const sharedGlobalIndex = firstCoverage.tiles[3].globalIndex
    const shiftedTile = secondCoverage.tiles.find((tile) => tile.globalIndex === sharedGlobalIndex)
    expect(shiftedTile).toBeDefined()
    expect(shiftedTile!.rangeStartSec).toBe(firstCoverage.tiles[3].rangeStartSec)
  })

  it('时长非法时降级为正数，不产生反向区间', () => {
    const grid = resolveHorizontalBrowseWaveformTileGrid({ renderWidthCssPx: 965, pixelRatio: 1 })
    const coverage = resolveHorizontalBrowseWaveformTileCoverage({
      grid,
      rangeStartSec: Number.NaN,
      rangeDurationSec: 0
    })
    expect(coverage.tiles[0].rangeStartSec).toBe(0)
    for (const tile of coverage.tiles) {
      expect(tile.rangeDurationSec).toBeGreaterThan(0)
    }
  })

  it('歌曲起点附近（负渲染起点）不越界，块序号可为负', () => {
    const grid = resolveHorizontalBrowseWaveformTileGrid({
      renderWidthCssPx: 6756,
      pixelRatio: 1.75
    })
    const coverage = resolveHorizontalBrowseWaveformTileCoverage({
      grid,
      rangeStartSec: -12.5,
      rangeDurationSec: 47.5
    })
    expect(coverage.tiles[0].globalIndex).toBeLessThan(0)
    expect(coverage.containerOffsetScaledPx).toBeGreaterThanOrEqual(0)
    expect(coverage.containerOffsetScaledPx).toBeLessThan(grid.tileScaledWidth)
    coverage.tiles.forEach((tile, index) => {
      const nextTile = coverage.tiles[index + 1]
      if (nextTile) expect(tile.rangeEndSec).toBe(nextTile.rangeStartSec)
    })
  })
})

describe('resolveHorizontalBrowseWaveformTilePriorities 优先级分档', () => {
  // 真机几何：viewport ≈965 CSS px 居中于 ≈6756 CSS px 渲染宽，左右对称 overscan。
  const grid = resolveHorizontalBrowseWaveformTileGrid({
    renderWidthCssPx: 6756,
    pixelRatio: 1.75
  })
  const coverage = resolveHorizontalBrowseWaveformTileCoverage({
    grid,
    rangeStartSec: 30,
    rangeDurationSec: 47.5
  })
  const viewportWidthCssPx = 965
  // 可见区在块容器坐标下的位置 = 渲染范围内偏移 + 容器原点偏移。
  const viewportStartCssPx = (6756 - viewportWidthCssPx) / 2 + coverage.containerOffsetCssPx

  it('与可见区有任何重叠的块都是 P0，且必然连续', () => {
    const priorities = resolveHorizontalBrowseWaveformTilePriorities({
      tiles: coverage.tiles,
      viewportStartCssPx,
      viewportWidthCssPx
    })
    const visibleIndexes = priorities
      .map((priority, index) => ({ priority, index }))
      .filter(({ priority }) => priority === HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE)
      .map(({ index }) => index)
    expect(visibleIndexes.length).toBeGreaterThanOrEqual(1)
    // 8 块 / 单块约 0.875 视口宽下，可见区最多跨 2 块——这正是「必须等的面积从 8/8 降到 2/8」。
    expect(visibleIndexes.length).toBeLessThanOrEqual(2)
    for (let cursor = 1; cursor < visibleIndexes.length; cursor += 1) {
      expect(visibleIndexes[cursor]).toBe(visibleIndexes[cursor - 1] + 1)
    }

    // 可见区被 P0 块完整覆盖：不允许可见区出现无人负责的空洞。
    const firstVisibleTile = coverage.tiles[visibleIndexes[0]]
    const lastVisibleTile = coverage.tiles[visibleIndexes[visibleIndexes.length - 1]]
    expect(firstVisibleTile.leftCssPx).toBeLessThanOrEqual(viewportStartCssPx)
    expect(lastVisibleTile.leftCssPx + lastVisibleTile.widthCssPx).toBeGreaterThanOrEqual(
      viewportStartCssPx + viewportWidthCssPx
    )
  })

  it('播放前进方向的屏幕外块是 P1，已播过方向是 P2', () => {
    const priorities = resolveHorizontalBrowseWaveformTilePriorities({
      tiles: coverage.tiles,
      viewportStartCssPx,
      viewportWidthCssPx
    })
    expect(priorities[0]).toBe(HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_BACKWARD)
    expect(priorities[priorities.length - 1]).toBe(HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_FORWARD)
  })

  it('反向拖动时前后两档互换，P0 不受影响', () => {
    const forwardPriorities = resolveHorizontalBrowseWaveformTilePriorities({
      tiles: coverage.tiles,
      viewportStartCssPx,
      viewportWidthCssPx,
      forward: true
    })
    const backwardPriorities = resolveHorizontalBrowseWaveformTilePriorities({
      tiles: coverage.tiles,
      viewportStartCssPx,
      viewportWidthCssPx,
      forward: false
    })
    forwardPriorities.forEach((forwardPriority, index) => {
      const backwardPriority = backwardPriorities[index]
      if (forwardPriority === HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE) {
        expect(backwardPriority).toBe(HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE)
        return
      }
      expect(backwardPriority).not.toBe(forwardPriority)
      expect(backwardPriority).not.toBe(HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE)
    })
  })

  it('仅相切（零重叠）不算可见，避免把边界外的块误升为 P0', () => {
    const priorities = resolveHorizontalBrowseWaveformTilePriorities({
      tiles: coverage.tiles,
      viewportStartCssPx: coverage.tiles[2].leftCssPx,
      viewportWidthCssPx: coverage.tiles[2].widthCssPx
    })
    expect(priorities[1]).not.toBe(HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE)
    expect(priorities[2]).toBe(HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE)
    expect(priorities[3]).not.toBe(HORIZONTAL_BROWSE_WAVEFORM_TILE_PRIORITY_VISIBLE)
  })
})
