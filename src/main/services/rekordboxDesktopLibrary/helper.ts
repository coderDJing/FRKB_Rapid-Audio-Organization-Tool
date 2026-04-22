import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import childProcess from 'node:child_process'
import { log } from '../../log'
import type {
  RekordboxDesktopHelperError,
  RekordboxDesktopHelperProgressPayload,
  RekordboxDesktopLibraryErrorCode
} from './types'

const ENV_RUNTIME_ROOT = 'FRKB_REKORDBOX_DESKTOP_RUNTIME_ROOT'
const ENV_PYTHON = 'FRKB_REKORDBOX_DESKTOP_PYTHON'
const ENV_BRIDGE = 'FRKB_REKORDBOX_DESKTOP_BRIDGE'

type RekordboxDesktopHelperCommand =
  | 'probe'
  | 'probe-write'
  | 'load-tree'
  | 'load-playlist-tracks'
  | 'create-empty-playlist'
  | 'move-playlist'
  | 'rename-playlist'
  | 'delete-playlist'
  | 'remove-playlist-tracks'
  | 'create-playlist'
  | 'append-playlist'
  | 'create-folder'

type RekordboxDesktopHelperRequest<TPayload> = {
  command: RekordboxDesktopHelperCommand
  payload: TPayload
}

type RekordboxDesktopHelperResponse<TResult> =
  | {
      ok: true
      result: TResult
    }
  | {
      ok: false
      error?: RekordboxDesktopHelperError
    }

type RekordboxDesktopHelperProgressEvent = {
  event?: string
  payload?: RekordboxDesktopHelperProgressPayload
}

type RunRekordboxDesktopHelperOptions = {
  onProgress?: (payload: RekordboxDesktopHelperProgressPayload) => void
}

type ResolvedPythonCommand = {
  command: string
  args: string[]
  runtimeSource: 'bundled' | 'env-python' | 'dev-launcher'
}

const BENIGN_STDERR_PATTERNS = [/pyrekordbox\.db6\.database:WARNING\s+-\s+Rekordbox is running!/i]

const sanitizeHelperStderr = (stderr: string) =>
  String(stderr || '')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !BENIGN_STDERR_PATTERNS.some((pattern) => pattern.test(line)))
    .join('\n')

const normalizeFsPath = (value: string) => {
  const normalized = String(value || '').trim()
  return normalized ? path.normalize(normalized) : ''
}

const resolveDesktopRuntimePlatformDir = () => {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return ''
}

const resolveDevAppRootCandidates = () => {
  const candidates: string[] = []
  const seen = new Set<string>()

  const addCandidate = (candidate: string) => {
    const normalized = normalizeFsPath(candidate)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }

  addCandidate(process.cwd())
  try {
    addCandidate(app.getAppPath())
  } catch {}
  addCandidate(path.resolve(__dirname, '../../..'))
  addCandidate(path.resolve(__dirname, '../../../..'))

  return candidates
}

const resolveDefaultRuntimeRootPath = () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'rekordboxDesktopRuntime')
  }
  const appRootCandidates = resolveDevAppRootCandidates()
  for (const appRoot of appRootCandidates) {
    const runtimeRoot = path.join(appRoot, 'vendor', 'rekordbox-desktop-runtime')
    if (fs.existsSync(runtimeRoot)) return runtimeRoot
  }
  return path.join(appRootCandidates[0] || process.cwd(), 'vendor', 'rekordbox-desktop-runtime')
}

const resolveRuntimeRootCandidates = () => {
  const candidates: string[] = []
  const seen = new Set<string>()
  const addCandidate = (candidate: string) => {
    const normalized = normalizeFsPath(candidate)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }

  addCandidate(process.env[ENV_RUNTIME_ROOT] || '')
  addCandidate(resolveDefaultRuntimeRootPath())
  return candidates
}

const resolveBundledRuntimeDir = () => {
  const platformDir = resolveDesktopRuntimePlatformDir()
  if (!platformDir) return ''
  for (const rootPath of resolveRuntimeRootCandidates()) {
    const runtimeDir = path.join(rootPath, platformDir, 'python')
    if (fs.existsSync(runtimeDir)) return runtimeDir
  }
  return path.join(resolveDefaultRuntimeRootPath(), platformDir, 'python')
}

const resolveBundledPythonPath = (runtimeDir: string) => {
  if (!runtimeDir) return ''
  if (process.platform === 'win32') {
    const rootPython = path.join(runtimeDir, 'python.exe')
    if (fs.existsSync(rootPython)) return rootPython
    const scriptsPython = path.join(runtimeDir, 'Scripts', 'python.exe')
    if (fs.existsSync(scriptsPython)) return scriptsPython
    return rootPython
  }
  const binPython3 = path.join(runtimeDir, 'bin', 'python3')
  if (fs.existsSync(binPython3)) return binPython3
  const binPython = path.join(runtimeDir, 'bin', 'python')
  if (fs.existsSync(binPython)) return binPython
  return binPython3
}

const resolveBridgeScriptCandidates = () => {
  const candidates: string[] = []
  const seen = new Set<string>()
  const addCandidate = (candidate: string) => {
    const normalized = normalizeFsPath(candidate)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }

  addCandidate(process.env[ENV_BRIDGE] || '')
  if (app.isPackaged) {
    addCandidate(
      path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'resources',
        'rekordboxDesktopLibrary',
        'bridge.py'
      )
    )
    addCandidate(path.join(process.resourcesPath, 'rekordboxDesktopLibrary', 'bridge.py'))
  } else {
    for (const appRoot of resolveDevAppRootCandidates()) {
      addCandidate(path.join(appRoot, 'resources', 'rekordboxDesktopLibrary', 'bridge.py'))
    }
  }
  return candidates
}

const resolveBridgeScriptPath = () => {
  const candidates = resolveBridgeScriptCandidates()
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return candidates[0] || ''
}

const resolvePythonCommand = (): ResolvedPythonCommand | null => {
  const envPython = normalizeFsPath(process.env[ENV_PYTHON] || '')
  if (envPython && fs.existsSync(envPython)) {
    return {
      command: envPython,
      args: [],
      runtimeSource: 'env-python'
    }
  }

  const bundledRuntimeDir = resolveBundledRuntimeDir()
  const bundledPythonPath = resolveBundledPythonPath(bundledRuntimeDir)
  if (bundledPythonPath && fs.existsSync(bundledPythonPath)) {
    return {
      command: bundledPythonPath,
      args: [],
      runtimeSource: 'bundled'
    }
  }

  if (!app.isPackaged) {
    if (process.platform === 'win32') {
      return {
        command: 'py',
        args: ['-3.11'],
        runtimeSource: 'dev-launcher'
      }
    }
    return {
      command: 'python3',
      args: [],
      runtimeSource: 'dev-launcher'
    }
  }

  return null
}

const createHelperError = (
  message: string,
  code: RekordboxDesktopLibraryErrorCode
): Error & RekordboxDesktopHelperError => {
  const error = new Error(message) as Error & RekordboxDesktopHelperError
  error.name = 'RekordboxDesktopLibraryError'
  error.code = code
  return error
}

export async function runRekordboxDesktopHelper<TResult, TPayload extends Record<string, unknown>>(
  command: RekordboxDesktopHelperCommand,
  payload: TPayload,
  options?: RunRekordboxDesktopHelperOptions
): Promise<TResult> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    throw createHelperError('当前平台暂不支持 Rekordbox 本机库。', 'UNSUPPORTED_PLATFORM')
  }

  const pythonCommand = resolvePythonCommand()
  if (!pythonCommand) {
    throw createHelperError(
      '未找到 Rekordbox Desktop Runtime 的 Python 运行时。',
      'PYTHON_RUNTIME_MISSING'
    )
  }

  const bridgePath = resolveBridgeScriptPath()
  if (!bridgePath || !fs.existsSync(bridgePath)) {
    throw createHelperError(
      `未找到 Rekordbox Desktop bridge: ${bridgePath || '<empty>'}`,
      'BRIDGE_SCRIPT_MISSING'
    )
  }

  const request: RekordboxDesktopHelperRequest<TPayload> = {
    command,
    payload
  }

  const spawnedArgs = [...pythonCommand.args, bridgePath]
  const childEnv = {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  }

  return await new Promise<TResult>((resolve, reject) => {
    const child = childProcess.spawn(pythonCommand.command, spawnedArgs, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv
    })

    let stdout = ''
    let stderr = ''
    let stdoutBuffer = ''
    let settled = false
    let response: RekordboxDesktopHelperResponse<TResult> | null = null

    const finishReject = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }

    const finishResolve = (value: TResult) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const handleParsedStdoutObject = (value: unknown) => {
      if (!value || typeof value !== 'object') return false

      const maybeEvent = value as RekordboxDesktopHelperProgressEvent
      if (maybeEvent.event === 'progress' && maybeEvent.payload && options?.onProgress) {
        try {
          options.onProgress(maybeEvent.payload)
        } catch (error) {
          log.error('[rekordbox-desktop-library] helper progress callback failed', {
            command,
            error
          })
        }
        return true
      }

      const maybeResponse = value as RekordboxDesktopHelperResponse<TResult>
      if (typeof maybeResponse.ok === 'boolean') {
        response = maybeResponse
        return true
      }

      return false
    }

    const consumeStdoutBuffer = (flush = false) => {
      const normalizedBuffer = flush ? stdoutBuffer : stdoutBuffer.replace(/\r\n/g, '\n')
      const segments = normalizedBuffer.split('\n')
      if (!flush) {
        stdoutBuffer = segments.pop() || ''
      } else {
        stdoutBuffer = ''
      }

      for (const segment of segments) {
        const trimmed = String(segment || '').trim()
        if (!trimmed) continue
        try {
          const parsed = JSON.parse(trimmed) as unknown
          if (!handleParsedStdoutObject(parsed)) {
            log.error('[rekordbox-desktop-library] helper returned unexpected event', {
              command,
              stdout: trimmed
            })
          }
        } catch {
          if (!flush) {
            stdoutBuffer = trimmed
            return
          }
          log.error('[rekordbox-desktop-library] helper returned invalid JSON line', {
            command,
            stdout: trimmed
          })
        }
      }
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      stdoutBuffer += text
      consumeStdoutBuffer(false)
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.once('error', (error) => {
      finishReject(
        createHelperError(
          `启动 Rekordbox Desktop helper 失败: ${error instanceof Error ? error.message : String(error || '')}`,
          'HELPER_RUNTIME_ERROR'
        )
      )
    })

    child.once('close', (code) => {
      consumeStdoutBuffer(true)
      const trimmedStdout = stdout.trim()
      const trimmedStderr = stderr.trim()
      const sanitizedStderr = sanitizeHelperStderr(trimmedStderr)
      if (!trimmedStdout && !response) {
        finishReject(
          createHelperError(
            sanitizedStderr ||
              `Rekordbox Desktop helper 未返回结果（exit=${String(code ?? '')}）。`,
            'HELPER_PROTOCOL_ERROR'
          )
        )
        return
      }

      if (!response && trimmedStdout) {
        try {
          response = JSON.parse(trimmedStdout) as RekordboxDesktopHelperResponse<TResult>
        } catch (error) {
          log.error('[rekordbox-desktop-library] helper returned invalid JSON', {
            command,
            stdout: trimmedStdout,
            stderr: sanitizedStderr
          })
          finishReject(
            createHelperError(
              `Rekordbox Desktop helper 返回了无效 JSON: ${error instanceof Error ? error.message : String(error || '')}`,
              'HELPER_PROTOCOL_ERROR'
            )
          )
          return
        }
      }

      if (!response?.ok) {
        const helperError = response?.error
        finishReject(
          createHelperError(
            helperError?.message ||
              sanitizedStderr ||
              `Rekordbox Desktop helper 执行失败（exit=${String(code ?? '')}）。`,
            (helperError?.code || 'HELPER_RUNTIME_ERROR') as RekordboxDesktopLibraryErrorCode
          )
        )
        return
      }
      finishResolve(response.result)
    })

    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}
