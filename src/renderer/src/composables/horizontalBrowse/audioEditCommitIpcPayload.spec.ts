import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { buildAudioEditCommitIpcPayload } from './audioEditCommitIpcPayload'

describe('buildAudioEditCommitIpcPayload', () => {
  it('从 Vue 响应式 Cue 生成可结构化克隆的保存参数', () => {
    const nested = reactive({ pioneer: true })
    const payload = buildAudioEditCommitIpcPayload({
      sessionId: 'session-1',
      sourceFilePath: 'D:\\library\\track.wav',
      listRoot: 'D:\\library',
      songListUUID: 'list-1',
      target: 'new-version',
      outputFormat: 'original',
      clips: reactive([{ sourceStartSec: 0, sourceEndSec: 8 }]),
      hotCues: reactive([{ slot: 0, sec: 1.5, extra: nested }]),
      memoryCues: reactive([{ sec: 4, extra: nested }]),
      title: 'Track',
      insertAfterFilePath: 'D:\\library\\track.wav',
      existingNames: reactive(['Track']),
      orderedFilePaths: reactive(['D:\\library\\track.wav'])
    })

    expect(() => structuredClone(payload)).not.toThrow()
    expect(payload.hotCues).toEqual([expect.objectContaining({ slot: 0, sec: 1.5 })])
    expect(payload.memoryCues).toEqual([expect.objectContaining({ sec: 4 })])
    expect((payload.hotCues[0] as { extra?: unknown }).extra).toBeUndefined()
  })
})
