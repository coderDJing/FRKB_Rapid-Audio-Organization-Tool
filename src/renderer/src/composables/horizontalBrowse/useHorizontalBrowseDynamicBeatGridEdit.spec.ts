import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  createSongBeatGridMapV2FromFixedGrid,
  normalizeSongBeatGridMapV2
} from '@shared/songBeatGridMapV2'
import { useHorizontalBrowseDynamicBeatGridEdit } from './useHorizontalBrowseDynamicBeatGridEdit'

describe('horizontal browse v2 grid downbeat picking', () => {
  it('uses a single-clip v2 grid instead of the retired root first-beat projection', () => {
    const beatGridMap = createSongBeatGridMapV2FromFixedGrid({
      bpm: 120,
      firstBeatMs: 2000,
      downbeatBeatOffset: 0,
      source: 'analysis'
    })
    if (!beatGridMap) throw new Error('failed to create v2 grid fixture')
    expect(
      normalizeSongBeatGridMapV2(beatGridMap, { durationSec: 10, allowSingleClip: true })
    ).not.toBeNull()

    const previewBeatGridMap = ref(beatGridMap)
    const controller = useHorizontalBrowseDynamicBeatGridEdit({
      // 双轨模式不开放动态分段编辑，但基础四拍线选择仍必须使用同一份 v2 网格。
      enabled: () => false,
      autoSyncFromSong: false,
      song: () => null,
      previewBeatGridMap,
      previewBpm: ref(120),
      previewBpmInput: ref('120'),
      previewFirstBeatMs: ref(0),
      previewDownbeatBeatOffset: ref(0),
      previewStartSec: ref(0),
      previewWrapRef: ref({
        getBoundingClientRect: () => ({ left: 0, width: 1000 })
      } as unknown as HTMLDivElement),
      resolveCurrentSec: () => 0,
      resolvePreviewAnchorSec: () => 0,
      resolvePreviewDurationSec: () => 0,
      resolveVisibleDurationSec: () => 10,
      clampPreviewStart: (value) => value,
      schedulePreviewDraw: () => {},
      schedulePersistGridDefinition: () => {}
    })

    expect(
      normalizeSongBeatGridMapV2(previewBeatGridMap.value, { allowSingleClip: true })
    ).not.toBeNull()
    expect(controller.hasV2GridMap.value).toBe(true)
    expect(controller.isDynamic.value).toBe(false)
    expect(controller.resolveDownbeatLinePickCandidateByClientX(200)).toMatchObject({
      beatIndex: 0,
      lineX: 200,
      hit: true
    })
  })
})
