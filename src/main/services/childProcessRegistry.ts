import childProcess, { type ChildProcess } from 'node:child_process'
import { log } from '../log'

type RegisteredChildProcess = {
  child: ChildProcess
  label: string
}

const registeredChildren = new Set<RegisteredChildProcess>()

const removeRegisteredChild = (entry: RegisteredChildProcess) => {
  registeredChildren.delete(entry)
}

export function registerChildProcess(child: ChildProcess, label = 'child-process'): () => void {
  const entry: RegisteredChildProcess = { child, label }
  registeredChildren.add(entry)
  const cleanup = () => removeRegisteredChild(entry)
  child.once('exit', cleanup)
  child.once('close', cleanup)
  child.once('error', cleanup)
  return cleanup
}

export function terminateChildProcess(child: ChildProcess, label = 'child-process'): void {
  if (!child.pid) return
  try {
    child.stdin?.write('q')
  } catch {}
  if (!child.killed) {
    try {
      child.kill()
    } catch {}
  }
  if (process.platform !== 'win32') return
  try {
    childProcess.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
  } catch (error) {
    log.error('[process] terminate child tree failed', { label, pid: child.pid, error })
  }
}

export function terminateRegisteredChildProcesses(): void {
  for (const entry of Array.from(registeredChildren)) {
    terminateChildProcess(entry.child, entry.label)
    removeRegisteredChild(entry)
  }
}
