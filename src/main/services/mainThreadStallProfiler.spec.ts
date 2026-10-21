import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Profiler } from 'node:inspector'
import { startMainThreadStallProfiler, summarizeStallProfiles } from './mainThreadStallProfiler'

const mocks = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }))
vi.mock('../log', () => ({ log: mocks }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

const profile: Profiler.Profile = {
  startTime: 0,
  endTime: 100_000,
  nodes: [
    {
      id: 1,
      callFrame: {
        functionName: '(root)',
        scriptId: '0',
        url: '',
        lineNumber: -1,
        columnNumber: -1
      },
      children: [2]
    },
    {
      id: 2,
      callFrame: {
        functionName: 'blockingWork',
        scriptId: '1',
        url: 'main.js',
        lineNumber: 9,
        columnNumber: 4
      }
    }
  ],
  samples: [2, 2, 1],
  timeDeltas: [10_000, 50_000, 10_000]
}

describe('main thread stall profiler', () => {
  it('只汇总停顿区间的栈，保留调用者、行号及采样空洞', () => {
    const summary = summarizeStallProfiles([{ profile, endedAtMs: 1100 }], 1020, 1065)
    expect(summary.sampleCount).toBe(1)
    expect(summary.maxSampleGapMs).toBe(40)
    expect(summary.topStacks[0].frames).toEqual(['blockingWork main.js:10:5', '(root) :0:0'])
  })

  it('采样停止后的尾部空洞也计入，区间外的 profile 不参与汇总', () => {
    const summary = summarizeStallProfiles([{ profile, endedAtMs: 1100 }], 1080, 1100)
    expect(summary.sampleCount).toBe(0)
    expect(summary.maxSampleGapMs).toBe(20)
    expect(summarizeStallProfiles([{ profile, endedAtMs: 1100 }], 1200, 1300).sampleCount).toBe(0)
  })

  it('真实 inspector 在采样轮换后可以继续采样，并只在 capture 时输出', async () => {
    const profiler = startMainThreadStallProfiler()
    expect(profiler).not.toBeNull()
    try {
      const since = Date.now()
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(mocks.warn).not.toHaveBeenCalled()
      profiler?.capture(since, Date.now())
      await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledTimes(1))
      expect(JSON.parse(mocks.warn.mock.calls[0][1]).sampleCount).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, 50))
      profiler?.capture(since, Date.now())
      await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledTimes(2))
      expect(mocks.error).not.toHaveBeenCalled()
    } finally {
      profiler?.dispose()
    }
  })

  it('支持用环境变量停用栈采样', () => {
    vi.stubEnv('FRKB_RC_STALL_PROFILING', '0')
    expect(startMainThreadStallProfiler()).toBeNull()
  })
})
