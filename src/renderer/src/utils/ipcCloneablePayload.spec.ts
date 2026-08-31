import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { toIpcCloneablePayload } from './ipcCloneablePayload'

describe('toIpcCloneablePayload', () => {
  it('剥掉 Vue 响应式包装，使结构化克隆可以成功', () => {
    const nested = reactive({ color: '#20c997' })
    const cues = reactive([{ slot: 0, sec: 1.25, extra: nested }])
    expect(() => structuredClone(cues)).toThrow()

    const payload = toIpcCloneablePayload({
      title: 'Track',
      hotCues: cues
    })
    expect(() => structuredClone(payload)).not.toThrow()
    expect(payload).toEqual({
      title: 'Track',
      hotCues: [{ slot: 0, sec: 1.25, extra: { color: '#20c997' } }]
    })
  })
})
