import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { attachMainWindowResponsivenessDiagnostics } from './responsivenessDiagnostics'

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  capture: vi.fn(),
  dispose: vi.fn(),
  context: vi.fn(),
  enabled: true
}))
vi.mock('../../log', () => ({ log: { error: mocks.error, info: vi.fn() } }))
vi.mock('../../services/mainProcessActivityTrace', () => ({
  getMainProcessStallContext: mocks.context
}))
vi.mock('../../services/playlistScanDiagnostics', () => ({
  getPlaylistScanDiagnosticSnapshot: () => []
}))
vi.mock('../../services/playlistOpenPerfTrace', () => ({
  getPlaylistOpenPerfSnapshot: () => ({})
}))
vi.mock('../../services/rcDiagnostics', () => ({ isPackagedRcBuild: () => mocks.enabled }))
vi.mock('../../services/mainThreadStallProfiler', () => ({
  startMainThreadStallProfiler: () => ({ capture: mocks.capture, dispose: mocks.dispose })
}))

let dispose: (() => void) | undefined
const makeWindow = () =>
  Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => true,
    webContents: Object.assign(new EventEmitter(), {
      id: 2,
      getOSProcessId: () => 123,
      getURL: () => 'file:///app.html',
      isLoading: () => false
    })
  }) as unknown as BrowserWindow

beforeEach(() => {
  vi.useFakeTimers()
  mocks.enabled = true
  mocks.context.mockReturnValue({
    power: { systemIdleState: 'idle', systemIdleSeconds: 60 },
    activity: { pending: [], slowest: [] }
  })
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.useRealTimers()
  vi.clearAllMocks()
})
const stall = (ms: number) => {
  vi.setSystemTime(Date.now() + ms)
  vi.advanceTimersByTime(1000)
}

describe('main window stall diagnostics', () => {
  it('用户空闲时保留每次现场，包括同一轮后续更长的卡顿', () => {
    dispose = attachMainWindowResponsivenessDiagnostics(makeWindow())
    stall(6000)
    stall(53000)
    const details = mocks.error.mock.calls.filter(
      ([name]) => name === '[main-window] main-process event loop stalled'
    )
    expect(details).toHaveLength(2)
    expect(JSON.parse(details[1][1])).toMatchObject({ stallIndex: 2, stallDurationMs: 53000 })
    expect(mocks.capture).toHaveBeenCalledTimes(2)
  })

  it('快照失败前先写最小现场，失败不影响下一次心跳诊断', () => {
    dispose = attachMainWindowResponsivenessDiagnostics(makeWindow())
    mocks.context.mockImplementationOnce(() => {
      throw new Error('snapshot failed')
    })
    expect(() => stall(6000)).not.toThrow()
    expect(mocks.error.mock.calls[0][0]).toBe('[main-window] main-process stall detected')
    expect(mocks.error.mock.calls[1][0]).toBe('[main-window] stall snapshot failed')
    stall(7000)
    expect(mocks.error.mock.calls.at(-1)?.[0]).toBe('[main-window] main-process event loop stalled')
  })

  it('正式版不采样、不建立诊断心跳', () => {
    mocks.enabled = false
    dispose = attachMainWindowResponsivenessDiagnostics(makeWindow())
    stall(6000)
    expect(mocks.capture).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
  })
})
