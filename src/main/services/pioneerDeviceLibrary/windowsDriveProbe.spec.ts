import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getWindowsDriveProbeSnapshot,
  parseDriveProbeStderr,
  runWindowsDriveProbe
} from './windowsDriveProbe'

afterEach(() => vi.unstubAllEnvs())

describe('Windows drive probe diagnostics', () => {
  it('剥离阶段标记但保留真正的探测错误，并限制阶段数量', () => {
    const phases = Array.from({ length: 20 }, (_, index) => `FRKB_DRIVE_PROBE_PHASE:phase-${index}`)
    const parsed = parseDriveProbeStderr([...phases, 'cim-usb-association: failed'].join('\r\n'))
    expect(parsed.stderr).toBe('cim-usb-association: failed')
    expect(parsed.phases).toHaveLength(12)
    expect(parsed.phases.at(-1)).toBe('phase-19')
    expect(parseDriveProbeStderr('FRKB_DRIVE_PROBE_PHASE:done\r\n').stderr).toBe('')
  })

  it.runIf(process.platform === 'win32')('诊断阶段不会污染成功的 JSON 或变成探测失败', async () => {
    vi.stubEnv('FRKB_APP_PACKAGED', '0')
    const result = await runWindowsDriveProbe(
      "Write-FrkbProbePhase 'serialize-usb-letters'\n[Console]::Out.WriteLine('[\"G:\"]')",
      5000,
      'test-success'
    )
    expect(JSON.parse(result.stdout)).toEqual(['G:'])
    expect(result.stderr).toBe('')
    expect(getWindowsDriveProbeSnapshot()).toEqual([])
  })

  it.runIf(process.platform === 'win32')('失败保留最后阶段和原始错误，且清理活动探测', async () => {
    vi.stubEnv('FRKB_APP_PACKAGED', '0')
    await expect(
      runWindowsDriveProbe(
        "Write-FrkbProbePhase 'cim-partitions'\n[Console]::Error.WriteLine('test probe failure')\nexit 7",
        5000,
        'test-failure'
      )
    ).rejects.toMatchObject({
      code: 7,
      stderr: 'test probe failure',
      driveProbe: { probe: 'test-failure', timeoutMs: 5000, lastPhase: 'cim-partitions' }
    })
    expect(getWindowsDriveProbeSnapshot()).toEqual([])
  })
})
