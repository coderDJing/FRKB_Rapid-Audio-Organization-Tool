import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { isSqliteReadDiagnosticsEnabled } from '../sqliteReadDiagnostics'

const execFileAsync = promisify(execFile)
const PHASE_PREFIX = 'FRKB_DRIVE_PROBE_PHASE:'
const activeProbes = new Map<string, { startedAtMs: number; timeoutMs: number }>()

/**
 * 用户要求保留的 RC/开发诊断；最近 12 个阶段只随真实探测错误落盘。
 * lastPhase 是子进程最后执行步骤；parentThreadCpuMs 是等待期间父进程主线程 CPU。
 * 完成超时根因修复和连续复测后，移除阶段标记和本模块的诊断字段。
 */
export const parseDriveProbeStderr = (stderr: string) => {
  const phases: string[] = []
  const errors: string[] = []
  for (const line of stderr.split(/\r?\n/)) {
    if (line.startsWith(PHASE_PREFIX)) phases.push(line.slice(PHASE_PREFIX.length, 200))
    else if (line.trim()) errors.push(line)
  }
  return { phases: phases.slice(-12), stderr: errors.join('\n') }
}

export const getWindowsDriveProbeSnapshot = () =>
  Array.from(activeProbes, ([probe, state]) => ({
    probe,
    timeoutMs: state.timeoutMs,
    elapsedMs: Date.now() - state.startedAtMs
  }))

export const runWindowsDriveProbe = async (script: string, timeoutMs: number, probe: string) => {
  const diagnostics = isSqliteReadDiagnosticsEnabled()
  const startedAt = performance.now()
  const startedThreadCpu = diagnostics ? process.threadCpuUsage() : null
  activeProbes.set(probe, { startedAtMs: Date.now(), timeoutMs })
  const phaseFunction = [
    'function Write-FrkbProbePhase([string]$phase) {',
    diagnostics
      ? `  [Console]::Error.WriteLine('${PHASE_PREFIX}' + $phase); [Console]::Error.Flush()`
      : '',
    '}'
  ].join('\n')
  try {
    const result = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `${phaseFunction}\n${script}`
      ],
      { windowsHide: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 * 8 }
    )
    return { stdout: result.stdout, stderr: parseDriveProbeStderr(result.stderr).stderr }
  } catch (error) {
    if (error instanceof Error) {
      const stderr = 'stderr' in error ? String(error.stderr || '') : ''
      const parsed = parseDriveProbeStderr(stderr)
      const threadCpu = startedThreadCpu ? process.threadCpuUsage(startedThreadCpu) : null
      Object.assign(error, {
        stderr: parsed.stderr,
        driveProbe: {
          probe,
          timeoutMs,
          elapsedMs: Math.round(performance.now() - startedAt),
          lastPhase: parsed.phases.at(-1) || 'powershell-startup',
          phases: parsed.phases,
          parentThreadCpuMs: threadCpu
            ? Math.round((threadCpu.user + threadCpu.system) / 1000)
            : null
        }
      })
    }
    throw error
  } finally {
    activeProbes.delete(probe)
  }
}
