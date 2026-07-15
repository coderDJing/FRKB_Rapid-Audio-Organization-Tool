import { describe, expect, it } from 'vitest'
import { createSongBeatGridMapV2FromClips } from '../../shared/songBeatGridMapV2'
import { CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION } from '../../shared/songStructure'
import { buildSetAnalysisSnapshot } from './setAnalysisSnapshot'

describe('Set analysis snapshot policy', () => {
  it('does not copy a grid while preserving non-grid analysis data', () => {
    const beatGridMap = createSongBeatGridMapV2FromClips(
      [
        { startSec: 0, anchorSec: 0.125, bpm: 128, downbeatBeatOffset: 0 },
        { startSec: 32, anchorSec: 32.2, bpm: 130, downbeatBeatOffset: 0 }
      ],
      'analysis'
    )
    if (!beatGridMap) throw new Error('test grid setup failed')

    const snapshot = buildSetAnalysisSnapshot({
      key: '8A',
      keyAnalysisAlgorithmVersion: 3,
      beatGridMap,
      energyScore: 0.7,
      energyAlgorithmVersion: 2,
      songStructure: {
        formatVersion: 1,
        algorithmVersion: CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION,
        source: 'algorithmic',
        durationSec: 60,
        bpm: 128,
        firstBeatMs: 125,
        barBeatOffset: 0,
        beatGridSignature: beatGridMap.signature,
        phraseBars: 8,
        sections: [
          {
            startSec: 0,
            endSec: 60,
            startBar: 1,
            endBar: 32,
            phraseIndex: 0,
            kind: 'groove',
            confidence: 0.6,
            energy: 0.6,
            low: 0.6,
            high: 0.4,
            novelty: 0.2
          }
        ]
      }
    })

    expect(snapshot).toMatchObject({
      key: '8A',
      energyScore: 0.7,
      songStructure: { algorithmVersion: CURRENT_SONG_STRUCTURE_ALGORITHM_VERSION }
    })
    expect(snapshot).not.toHaveProperty('bpm')
    expect(snapshot).not.toHaveProperty('firstBeatMs')
    expect(snapshot).not.toHaveProperty('barBeatOffset')
    expect(snapshot).not.toHaveProperty('beatGridMap')
  })
})
