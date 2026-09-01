import { afterEach, describe, expect, it } from 'vitest'
import {
  isHorizontalBrowseWaveformTileRenderingEnabled,
  setHorizontalBrowseWaveformTileRenderingEnabled
} from './horizontalBrowseWaveformTileFlag'

// 分块路径默认开启（阶段 1~4 已实现，待真机验收）；关闭即完整回退到单张超宽位图路径。
// 这里锁住开关双向可切换，回退能力不会因后续改动而失效。
// 见 drafts/大波形分块瓦片渲染设计.md 的分阶段实施要求。
describe('horizontalBrowseWaveformTileFlag', () => {
  afterEach(() => {
    setHorizontalBrowseWaveformTileRenderingEnabled(true)
  })

  it('默认开启', () => {
    expect(isHorizontalBrowseWaveformTileRenderingEnabled()).toBe(true)
  })

  it('可关闭以回退旧路径，并能再次开启', () => {
    setHorizontalBrowseWaveformTileRenderingEnabled(false)
    expect(isHorizontalBrowseWaveformTileRenderingEnabled()).toBe(false)
    setHorizontalBrowseWaveformTileRenderingEnabled(true)
    expect(isHorizontalBrowseWaveformTileRenderingEnabled()).toBe(true)
  })

  it('非布尔真值不会被当作开启', () => {
    setHorizontalBrowseWaveformTileRenderingEnabled('yes' as unknown as boolean)
    expect(isHorizontalBrowseWaveformTileRenderingEnabled()).toBe(false)
  })
})
