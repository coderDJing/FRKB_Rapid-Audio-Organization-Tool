import { describe, expect, it } from 'vitest'
import { createMixtapeMasterGrid } from './mixtapeMasterGrid'
import { resolveSyncPlaybackRateWithDiagnostics } from './beatSyncModel'

describe('dynamic master BPM phase sync', () => {
  it('keeps anchors separated by whole master beats phase-aligned during a BPM ramp', () => {
    const masterGrid = createMixtapeMasterGrid({
      points: [
        { sec: 0, bpm: 128 },
        { sec: 10, bpm: 128 },
        { sec: 20, bpm: 129 }
      ],
      fallbackBpm: 128
    })
    const targetAnchorSec = masterGrid.mapBeatsToSec(32)
    const baseParams = {
      basePlaybackRate: 1,
      targetBpm: 128.5,
      masterBpm: 128.5,
      targetAnchorSec,
      masterAnchorSec: 0,
      timelineSec: 18,
      phaseLockStrength: 0.16,
      maxPhasePull: 0.05
    }

    const legacy = resolveSyncPlaybackRateWithDiagnostics(baseParams)
    const integrated = resolveSyncPlaybackRateWithDiagnostics({
      ...baseParams,
      mapMasterSecToBeats: masterGrid.mapSecToBeats
    })

    expect(Math.abs(legacy.phaseErrorSec)).toBeGreaterThan(0.001)
    expect(Math.abs(integrated.phaseErrorSec)).toBeLessThan(0.0001)
    expect(Math.abs(integrated.rate - 1)).toBeLessThan(0.0001)
  })
})
