import childProcess, { type ChildProcess } from 'node:child_process'

const ANALYSIS_THREAD_LIMITS: NodeJS.ProcessEnv = {
  OMP_NUM_THREADS: '1',
  MKL_NUM_THREADS: '1',
  OPENBLAS_NUM_THREADS: '1',
  NUMEXPR_NUM_THREADS: '1',
  TORCH_NUM_THREADS: '1',
  VECLIB_MAXIMUM_THREADS: '1',
  BLIS_NUM_THREADS: '1',
  ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS: '1'
}

export const buildAnalysisChildEnv = (
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => ({
  ...baseEnv,
  ...ANALYSIS_THREAD_LIMITS
})

const runPriorityCommand = (command: string, args: string[]) => {
  childProcess.execFile(command, args, { windowsHide: true, timeout: 5000 }, () => undefined)
}

export const lowerAnalysisProcessPriority = (child: Pick<ChildProcess, 'pid'>) => {
  const pid = child.pid
  if (!pid || pid <= 0) return

  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
      "if ($p) { $p.PriorityClass = 'BelowNormal' }"
    ].join('; ')
    runPriorityCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ])
    return
  }

  if (process.platform === 'darwin' || process.platform === 'linux') {
    runPriorityCommand('renice', ['-n', '10', '-p', String(pid)])
  }
}
