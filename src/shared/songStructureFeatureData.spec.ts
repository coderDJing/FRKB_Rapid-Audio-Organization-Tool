import { describe, expect, it } from 'vitest'
import {
  buildSongStructureFeatureDataFromMixxx,
  getSongStructureFeaturePayloadBytes,
  isValidSongStructureFeatureData,
  type SongStructureFeatureSource
} from './songStructureFeatureData'

const createBand = (body: readonly number[], peak: readonly number[]) => ({
  left: Uint8Array.from(body),
  right: Uint8Array.from(body),
  peakLeft: Uint8Array.from(peak),
  peakRight: Uint8Array.from(peak)
})

const createSource = (
  body: readonly number[],
  peak: readonly number[],
  sourceRate: number
): SongStructureFeatureSource => ({
  duration: body.length / sourceRate,
  sampleRate: sourceRate * 100,
  step: 100,
  bands: {
    low: createBand(body, peak),
    mid: createBand(
      body.map((value) => value + 5),
      peak.map((value) => value + 5)
    ),
    high: createBand(
      body.map((value) => value + 10),
      peak.map((value) => value + 10)
    ),
    all: createBand(
      body.map((value) => value + 15),
      peak.map((value) => value + 15)
    )
  }
})

describe('SongStructureFeatureData', () => {
  it('将 Mixxx absolute 四频带压缩为固定帧率的 12 通道字节特征', () => {
    const source = createSource(
      Array.from({ length: 64 }, (_unused, index) => 20 + (index % 8)),
      Array.from({ length: 64 }, (_unused, index) => 40 + (index % 8)),
      32
    )
    const result = buildSongStructureFeatureDataFromMixxx(source, 8)

    expect(result).not.toBeNull()
    expect(result?.frameRate).toBe(8)
    expect(result?.frameCount).toBe(16)
    expect(isValidSongStructureFeatureData(result)).toBe(true)
    expect(result ? getSongStructureFeaturePayloadBytes(result) : 0).toBe(16 * 12)
  })

  it('robust peak 使用 P90，单个极端峰值不会污染整个目标窗口', () => {
    const body = new Array(20).fill(30)
    const peak = new Array(20).fill(100)
    peak[10] = 255
    const result = buildSongStructureFeatureDataFromMixxx(createSource(body, peak, 20), 4)

    expect(result?.bands.low.peak[0]).toBe(100)
    expect(result?.bands.all.peak[0]).toBe(115)
  })

  it('拒绝不受支持的过低或过高实验帧率', () => {
    const source = createSource(new Array(20).fill(30), new Array(20).fill(60), 20)

    expect(buildSongStructureFeatureDataFromMixxx(source, 2)).toBeNull()
    expect(buildSongStructureFeatureDataFromMixxx(source, 128)).toBeNull()
  })

  it('在高分辨率包络降采样前保留 fast/slow EMA onset', () => {
    const body = [...new Array(20).fill(20), ...new Array(20).fill(180)]
    const result = buildSongStructureFeatureDataFromMixxx(createSource(body, body, 40), 8)

    expect(Math.max(...(result?.bands.all.onset ?? []))).toBeGreaterThan(0)
  })
})
