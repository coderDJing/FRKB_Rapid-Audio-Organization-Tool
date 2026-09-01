import { afterEach, describe, expect, it } from 'vitest'
import { createHorizontalBrowseLiveCanvasBuffers } from './horizontalBrowseLiveCanvasBuffers'
import { setHorizontalBrowseWaveformTileRenderingEnabled } from './horizontalBrowseWaveformTileFlag'

// flag 关闭时分块路径必须完全惰性：几何只写旧的单张超宽 canvas，位移目标仍是那张 canvas，
// 块容器一行 style 都不能被碰。这是「flag 关闭即完全走现有路径，可随时回退」的机器可验证形式。
// 见 drafts/大波形分块瓦片渲染设计.md 的分阶段实施要求。

const createStubElement = <T>() => {
  const style: Record<string, string> = {
    setProperty(name: string, value: string) {
      style[name.replace(/-([a-z])/g, (_unused, letter: string) => letter.toUpperCase())] = value
    },
    removeProperty(name: string) {
      delete style[name.replace(/-([a-z])/g, (_unused, letter: string) => letter.toUpperCase())]
    }
  } as unknown as Record<string, string>
  return {
    style,
    getBoundingClientRect: () => ({ width: 0 }),
    tagName: 'STUB'
  } as unknown as T & { style: Record<string, string> }
}

const attachBuffers = () => {
  const buffers = createHorizontalBrowseLiveCanvasBuffers()
  const waveformFront = createStubElement<HTMLCanvasElement>()
  const waveformBack = createStubElement<HTMLCanvasElement>()
  const overlayFront = createStubElement<HTMLCanvasElement>()
  const overlayBack = createStubElement<HTMLCanvasElement>()
  const tileContainerFront = createStubElement<HTMLDivElement>()
  const tileContainerBack = createStubElement<HTMLDivElement>()
  const tileFront = createStubElement<HTMLCanvasElement>()
  const tileBack = createStubElement<HTMLCanvasElement>()
  buffers.waveformCanvasRef.value = waveformFront
  buffers.waveformCanvasBackRef.value = waveformBack
  buffers.overlayCanvasRef.value = overlayFront
  buffers.overlayCanvasBackRef.value = overlayBack
  buffers.waveformTileContainerRefs[0].value = tileContainerFront
  buffers.waveformTileContainerRefs[1].value = tileContainerBack
  buffers.waveformTileCanvasRefs[0].value = [tileFront]
  buffers.waveformTileCanvasRefs[1].value = [tileBack]
  return {
    buffers,
    waveformFront,
    waveformBack,
    overlayFront,
    tileContainerFront,
    tileContainerBack,
    tileFront
  }
}

describe('horizontalBrowseLiveCanvasBuffers flag 关闭时分块路径惰性', () => {
  // 默认开启，因此需要显式关闭来验证回退路径。
  afterEach(() => {
    setHorizontalBrowseWaveformTileRenderingEnabled(true)
  })

  it('flag 关闭时 setGeometry 只写旧超宽 canvas，不碰块容器', () => {
    setHorizontalBrowseWaveformTileRenderingEnabled(false)
    const { buffers, waveformFront, tileContainerFront, tileContainerBack } = attachBuffers()
    buffers.setGeometry(-2896, 6756, 96, 120)
    expect(waveformFront.style.width).toBe('6756px')
    expect(waveformFront.style.left).toBe('-2896px')
    // 块容器完全没有被写入任何几何。
    expect(tileContainerFront.style.width).toBeUndefined()
    expect(tileContainerFront.style.left).toBeUndefined()
    expect(tileContainerBack.style.width).toBeUndefined()
  })

  it('flag 关闭时位移目标是旧超宽 canvas', () => {
    setHorizontalBrowseWaveformTileRenderingEnabled(false)
    const { buffers, waveformFront, tileContainerFront } = attachBuffers()
    buffers.applyPresentationOffset(-123.5, true)
    expect(waveformFront.style.transform).toBe('translate3d(-123.5px, 0, 0)')
    expect(tileContainerFront.style.transform).toBeUndefined()
  })

  it('flag 开启时几何写到块容器，旧超宽 canvas 不再被摆放', () => {
    setHorizontalBrowseWaveformTileRenderingEnabled(true)
    const { buffers, waveformFront, overlayFront, tileContainerFront } = attachBuffers()
    buffers.setGeometry(-2896, 6756, 96, 120)
    expect(tileContainerFront.style.width).toBe('6756px')
    expect(tileContainerFront.style.left).toBe('-2896px')
    expect(tileContainerFront.style.height).toBe('96px')
    // 波形侧改由块容器承载，旧 canvas 不再参与布局；overlay 不分块，仍照旧摆放。
    expect(waveformFront.style.width).toBeUndefined()
    expect(overlayFront.style.width).toBe('6756px')
  })

  it('flag 开启时位移挂在块容器上，不落到每块（避免边界亚像素错位）', () => {
    setHorizontalBrowseWaveformTileRenderingEnabled(true)
    const { buffers, tileContainerFront, tileFront } = attachBuffers()
    buffers.applyPresentationOffset(-123.5, true)
    expect(tileContainerFront.style.transform).toBe('translate3d(-123.5px, 0, 0)')
    expect(tileFront.style.transform).toBeUndefined()
  })

  it('applyTileLayout 摆放用到的块并隐藏本轮不用的块', () => {
    setHorizontalBrowseWaveformTileRenderingEnabled(true)
    const buffers = createHorizontalBrowseLiveCanvasBuffers()
    const usedTile = createStubElement<HTMLCanvasElement>()
    const unusedTile = createStubElement<HTMLCanvasElement>()
    buffers.waveformTileCanvasRefs[0].value = [usedTile, unusedTile]
    buffers.applyTileLayout(0, [{ slotIndex: 0, leftCssPx: 512, widthCssPx: 1478 }], 96)
    expect(usedTile.style.left).toBe('512px')
    expect(usedTile.style.width).toBe('1478px')
    expect(usedTile.style.height).toBe('96px')
    expect(usedTile.style.visibility).toBe('visible')
    // 未参与本轮的块仍持有上一代内容，必须隐藏，否则会露出错位画面。
    expect(unusedTile.style.visibility).toBe('hidden')
  })

  it('flag 开启时可见面切换发生在块容器层', () => {
    setHorizontalBrowseWaveformTileRenderingEnabled(true)
    const { buffers, tileContainerFront, tileContainerBack } = attachBuffers()
    buffers.activate(1)
    expect(tileContainerBack.style.opacity).toBe('1')
    expect(tileContainerFront.style.opacity).toBe('0')
    buffers.activate(0)
    expect(tileContainerFront.style.opacity).toBe('1')
    expect(tileContainerBack.style.opacity).toBe('0')
  })
})
