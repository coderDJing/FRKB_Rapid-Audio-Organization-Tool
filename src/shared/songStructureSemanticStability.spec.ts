import { describe, expect, it } from 'vitest'
import type { SongStructureSectionKind } from './songStructureCommon'
import type { SongStructureSemanticRange } from './songStructureSemanticOutro'
import { stabilizeSongStructureSemanticRanges } from './songStructureSemanticStability'

const createRange = (
  startIndex: number,
  endIndex: number,
  kind: SongStructureSectionKind
): SongStructureSemanticRange => ({
  startIndex,
  endIndex,
  kind,
  confidence: 0.7,
  clusterId: 1,
  entryBoundaryScore: 0.4
})

describe('songStructureSemanticStability', () => {
  it('吸收 Breakdown 与 Build 之间不足四个四拍块的伪 Drop', () => {
    expect(
      stabilizeSongStructureSemanticRanges([
        createRange(0, 8, 'breakdown'),
        createRange(8, 11, 'drop'),
        createRange(11, 12, 'breakdown'),
        createRange(12, 20, 'build'),
        createRange(20, 40, 'drop')
      ])
    ).toMatchObject([
      { startIndex: 0, endIndex: 8, kind: 'breakdown' },
      { startIndex: 8, endIndex: 20, kind: 'build' },
      { startIndex: 20, endIndex: 40, kind: 'drop' }
    ])
  })

  it('不会保留两个相邻的同标签范围', () => {
    expect(
      stabilizeSongStructureSemanticRanges([
        createRange(0, 16, 'groove'),
        createRange(16, 40, 'groove'),
        createRange(40, 48, 'outro')
      ])
    ).toMatchObject([
      { startIndex: 0, endIndex: 40, kind: 'groove' },
      { startIndex: 40, endIndex: 48, kind: 'outro' }
    ])
  })
})
