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

  it('保留封面和波形的二进制类型及可克隆的原生对象', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const waveform = new Float32Array([0.25, -0.5])
    const createdAt = new Date('2026-10-21T00:00:00Z')
    const payload = toIpcCloneablePayload(
      reactive({ cover: { format: 'image/png', data: bytes }, waveform, createdAt })
    )

    const cloned = structuredClone(payload)
    expect(cloned.cover.data).toBeInstanceOf(Uint8Array)
    expect(cloned.cover.data).toEqual(bytes)
    expect(cloned.waveform).toBeInstanceOf(Float32Array)
    expect(cloned.waveform).toEqual(waveform)
    expect(cloned.createdAt).toBeInstanceOf(Date)
    expect(cloned.createdAt).toEqual(createdAt)
  })
})
