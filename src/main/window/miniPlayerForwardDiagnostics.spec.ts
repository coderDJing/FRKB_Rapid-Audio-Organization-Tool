import { describe, expect, it } from 'vitest'
import { createMiniPlayerForwardDiagnostics } from './miniPlayerForwardDiagnostics'

describe('mini player forward diagnostics', () => {
  it('按序号匹配异常前后转发记录，且内存有界并可随会话清理', () => {
    const diagnostics = createMiniPlayerForwardDiagnostics()
    for (let sequence = 0; sequence < 200; sequence++) {
      diagnostics.record({
        sequence,
        publishedAtMs: sequence,
        receivedAtMs: sequence + 1,
        forwardedAtMs: sequence + 2,
        targetWindowId: 2,
        outcome: 'sent'
      })
    }
    expect(diagnostics.snapshot(0, 198)).toMatchObject({
      previous: undefined,
      incoming: { sequence: 198 },
      latest: { sequence: 199 }
    })
    diagnostics.clear()
    expect(diagnostics.snapshot().latest).toBeUndefined()
  })
})
