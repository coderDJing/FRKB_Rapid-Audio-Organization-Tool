import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolveBundledDemucsBootstrapDirPath } from '../demucs'
import { log } from '../log'
import mixtapeWindow from '../window/mixtapeWindow'

const XPU_WORKER_POOL_SIZE = 2
const XPU_WORKER_PRIMARY_IDLE_TIMEOUT_MS = 120_000
const XPU_WORKER_SECONDARY_IDLE_TIMEOUT_MS = 180_000
const XPU_WORKER_WINDOW_CLOSE_GRACE_MS = 5_000
const XPU_WORKER_MESSAGE_TIMEOUT_MS = 2 * 60 * 1000

type PersistentWorkerWarmupPayload = {
  modelName: string
  modelRepoPath: string
  device: 'xpu'
  segmentSec: number | null
}

type PersistentWorkerInferPayload = {
  mode: 'waveform_inference'
  inputPcmPath: string
  inputSampleRate: number
  inputChannels: number
  inputFrames: number
  device: string
  modelName: string
  modelRepoPath: string
  outputDir: string
  shifts: number
  overlap: number
  split: boolean
  segmentSec: number | null
  jobs: number
  sourcePath: string
}

type PersistentWorkerRequest =
  | {
      type: 'warmup'
      requestId: string
      payload: PersistentWorkerWarmupPayload
    }
  | {
      type: 'infer'
      requestId: string
      payload: PersistentWorkerInferPayload
    }
  | {
      type: 'shutdown'
      requestId: string
    }

type PersistentWorkerResponse =
  | {
      type: 'ready'
      requestId: string
      payload?: {
        modelName?: string
        device?: string
      }
    }
  | {
      type: 'result'
      requestId: string
      payload?: Record<string, unknown>
    }
  | {
      type: 'error'
      requestId: string
      error?: string
      code?: string
    }

type RunPersistentXpuStemInferenceParams = {
  pythonPath: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  traceLabel: string
  payload: PersistentWorkerInferPayload
  onStderrChunk?: (chunk: string) => void
}

type InflightRequest = {
  id: string
  type: 'warmup' | 'infer' | 'shutdown'
  startedAt: number
  timeoutTimer: NodeJS.Timeout | null
  stderrText: string
  onStderrChunk?: (chunk: string) => void
  resolve: (value: PersistentWorkerResponse) => void
  reject: (error: Error) => void
}

const normalizeText = (value: unknown, maxLen = 4000): string => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen)
}

const createWorkerError = (code: string, message: string) => {
  const error = new Error(message)
  ;(error as any).code = code
  return error
}

class PersistentXpuStemWorkerSlot {
  private child: childProcess.ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private inflight: InflightRequest | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private signature = ''
  private reserved = false
  private requestSeq = 0

  constructor(
    private readonly slotId: number,
    private readonly workerScriptPath: string
  ) {}

  private get idleTimeoutMs() {
    return this.slotId === 1
      ? XPU_WORKER_PRIMARY_IDLE_TIMEOUT_MS
      : XPU_WORKER_SECONDARY_IDLE_TIMEOUT_MS
  }

  hasChild() {
    return !!this.child
  }

  isBusy() {
    return this.reserved || !!this.inflight
  }

  isReusable(signature: string) {
    return !!this.child && this.signature === signature && !this.isBusy()
  }

  isRespawnable() {
    return !this.isBusy()
  }

  reserve() {
    if (this.isBusy()) {
      throw createWorkerError(
        'PERSISTENT_XPU_WORKER_BUSY',
        `XPU 常驻 worker#${this.slotId} 正忙，回退旧路径`
      )
    }
    this.reserved = true
    this.clearIdleTimer()
  }

  private releaseReservation() {
    this.reserved = false
  }

  private clearIdleTimer() {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  scheduleShutdown(delayMs: number, reason: string) {
    this.clearIdleTimer()
    if (!this.child) return
    this.idleTimer = setTimeout(
      () => {
        if (this.isBusy()) {
          this.scheduleShutdown(this.idleTimeoutMs, `${reason}:deferred`)
          return
        }
        this.stopWorker(reason)
      },
      Math.max(1000, Number(delayMs) || this.idleTimeoutMs)
    )
  }

  private rejectInflight(error: Error) {
    const inflight = this.inflight
    if (!inflight) return
    this.inflight = null
    if (inflight.timeoutTimer) clearTimeout(inflight.timeoutTimer)
    inflight.reject(error)
  }

  private settleInflight(response: PersistentWorkerResponse) {
    const inflight = this.inflight
    if (!inflight) return
    if (inflight.id !== response.requestId) return
    this.inflight = null
    if (inflight.timeoutTimer) clearTimeout(inflight.timeoutTimer)
    inflight.resolve(response)
  }

  private handleWorkerExit(
    child: childProcess.ChildProcessWithoutNullStreams,
    reason: string,
    stderrFallback = ''
  ) {
    if (this.child !== child) return
    const errorMessage = normalizeText(stderrFallback, 2000) || reason
    const error = createWorkerError('PERSISTENT_XPU_WORKER_EXITED', errorMessage)
    this.child = null
    this.stdoutBuffer = ''
    this.signature = ''
    this.reserved = false
    this.clearIdleTimer()
    this.rejectInflight(error)
  }

  private handleStdoutChunk(chunk: string) {
    const text = String(chunk || '')
    if (!text) return
    this.stdoutBuffer += text
    const lines = this.stdoutBuffer.split(/\r?\n/)
    this.stdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      const normalized = normalizeText(line, 8000)
      if (!normalized) continue
      try {
        const message = JSON.parse(normalized) as PersistentWorkerResponse
        if (message.type === 'error') {
          const error = createWorkerError(
            normalizeText(message.code, 80) || 'PERSISTENT_XPU_WORKER_ERROR',
            normalizeText(message.error, 3000) || 'persistent xpu worker failed'
          )
          this.rejectInflight(error)
          continue
        }
        this.settleInflight(message)
      } catch (error) {
        log.warn('[mixtape-stem] persistent xpu worker stdout parse failed', {
          slotId: this.slotId,
          line: normalized.slice(0, 300),
          error: normalizeText(error instanceof Error ? error.message : String(error || ''), 400)
        })
      }
    }
  }

  private spawnWorker(pythonPath: string, env: NodeJS.ProcessEnv, signature: string) {
    if (!fs.existsSync(this.workerScriptPath)) {
      throw createWorkerError(
        'PERSISTENT_XPU_WORKER_SCRIPT_MISSING',
        `未找到 XPU 常驻 worker 脚本: ${this.workerScriptPath}`
      )
    }
    this.stopWorker('respawn')
    try {
      const child = childProcess.spawn(pythonPath, [this.workerScriptPath], {
        windowsHide: true,
        env
      })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (this.child !== child) return
        this.handleStdoutChunk(chunk)
      })
      child.stderr.on('data', (chunk: string) => {
        if (this.child !== child) return
        const inflight = this.inflight
        if (!inflight) return
        inflight.stderrText += String(chunk || '')
        inflight.onStderrChunk?.(String(chunk || ''))
      })
      child.on('error', (error) => {
        this.handleWorkerExit(
          child,
          normalizeText(
            error instanceof Error ? error.message : String(error || 'worker error'),
            800
          )
        )
      })
      child.on('close', (code) => {
        this.handleWorkerExit(
          child,
          `persistent xpu worker exit=${typeof code === 'number' ? code : -1}`,
          this.inflight?.stderrText || ''
        )
      })
      this.child = child
      this.signature = signature
    } catch (error) {
      throw createWorkerError(
        'PERSISTENT_XPU_WORKER_SPAWN_FAILED',
        normalizeText(
          error instanceof Error ? error.message : String(error || 'spawn failed'),
          1200
        ) || 'spawn failed'
      )
    }
  }

  private sendRequest<T extends PersistentWorkerResponse>(
    request: PersistentWorkerRequest,
    timeoutMs: number,
    onStderrChunk?: (chunk: string) => void
  ): Promise<T> {
    if (!this.child) {
      throw createWorkerError('PERSISTENT_XPU_WORKER_UNAVAILABLE', 'XPU 常驻 worker 未启动')
    }
    if (this.inflight) {
      throw createWorkerError(
        'PERSISTENT_XPU_WORKER_BUSY',
        `XPU 常驻 worker#${this.slotId} 正忙，回退旧路径`
      )
    }
    return new Promise<T>((resolve, reject) => {
      const timeoutTimer = setTimeout(
        () => {
          this.rejectInflight(
            createWorkerError('PERSISTENT_XPU_WORKER_TIMEOUT', `${request.type} 超时，回退旧路径`)
          )
          this.stopWorker('timeout')
        },
        Math.max(1000, Number(timeoutMs) || XPU_WORKER_MESSAGE_TIMEOUT_MS)
      )
      this.inflight = {
        id: request.requestId,
        type: request.type,
        startedAt: Date.now(),
        timeoutTimer,
        stderrText: '',
        onStderrChunk,
        resolve: (value) => resolve(value as T),
        reject
      }
      try {
        this.child?.stdin.write(`${JSON.stringify(request)}\n`, 'utf8')
      } catch (error) {
        this.rejectInflight(
          createWorkerError(
            'PERSISTENT_XPU_WORKER_STDIN_FAILED',
            normalizeText(
              error instanceof Error ? error.message : String(error || 'stdin failed'),
              1200
            ) || 'stdin failed'
          )
        )
      }
    })
  }

  private nextRequestId() {
    this.requestSeq += 1
    return `slot-${this.slotId}-${Date.now()}-${this.requestSeq}`
  }

  private async ensureReady(params: RunPersistentXpuStemInferenceParams, signature: string) {
    if (this.child && this.signature === signature) return
    this.spawnWorker(params.pythonPath, params.env, signature)
    const warmupPayload: PersistentWorkerWarmupPayload = {
      modelName: params.payload.modelName,
      modelRepoPath: params.payload.modelRepoPath,
      device: 'xpu',
      segmentSec: params.payload.segmentSec
    }
    await this.sendRequest(
      {
        type: 'warmup',
        requestId: this.nextRequestId(),
        payload: warmupPayload
      },
      Math.min(Math.max(params.timeoutMs, 30_000), XPU_WORKER_MESSAGE_TIMEOUT_MS)
    )
  }

  async runInference(params: RunPersistentXpuStemInferenceParams, signature: string) {
    if (params.payload.device !== 'xpu') {
      this.releaseReservation()
      throw createWorkerError('PERSISTENT_XPU_WORKER_INVALID_DEVICE', '仅支持 xpu 设备')
    }
    try {
      await this.ensureReady(params, signature)
    } catch (error) {
      this.releaseReservation()
      this.stopWorker('warmup-failed')
      throw error
    }
    this.releaseReservation()
    try {
      await this.sendRequest(
        {
          type: 'infer',
          requestId: this.nextRequestId(),
          payload: params.payload
        },
        params.timeoutMs,
        params.onStderrChunk
      )
      this.scheduleShutdown(this.idleTimeoutMs, 'idle-timeout')
    } catch (error) {
      this.stopWorker('infer-failed')
      throw error
    }
  }

  stopWorker(reason: string) {
    this.clearIdleTimer()
    const child = this.child
    this.child = null
    this.stdoutBuffer = ''
    this.signature = ''
    this.reserved = false
    if (!child) return
    try {
      child.kill()
    } catch {}
  }
}

class PersistentXpuStemWorkerManager {
  private readonly workerScriptPath = path.join(
    resolveBundledDemucsBootstrapDirPath(),
    'mixtape_demucs_worker.py'
  )
  private readonly slots = Array.from(
    { length: XPU_WORKER_POOL_SIZE },
    (_item, index) => new PersistentXpuStemWorkerSlot(index + 1, this.workerScriptPath)
  )
  private boundWindowClose = false
  private allocationLock: Promise<void> = Promise.resolve()

  private ensureWindowHooks() {
    if (this.boundWindowClose) return
    this.boundWindowClose = true
    mixtapeWindow.onAllClosed?.(() => {
      this.scheduleShutdownAll(XPU_WORKER_WINDOW_CLOSE_GRACE_MS, 'mixtape-window-closed')
    })
  }

  private scheduleShutdownAll(delayMs: number, reason: string) {
    for (const slot of this.slots) {
      slot.scheduleShutdown(delayMs, reason)
    }
  }

  private withAllocationLock = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    const previous = this.allocationLock
    let release: () => void = () => {}
    this.allocationLock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private buildSignature(params: RunPersistentXpuStemInferenceParams) {
    return [
      params.pythonPath,
      params.payload.device,
      params.payload.modelName,
      params.payload.modelRepoPath
    ].join('::')
  }

  private pickSlot(signature: string) {
    const reusable = this.slots.find((slot) => slot.isReusable(signature))
    if (reusable) return reusable
    const empty = this.slots.find((slot) => !slot.hasChild() && slot.isRespawnable())
    if (empty) return empty
    const respawnable = this.slots.find((slot) => slot.isRespawnable())
    if (respawnable) return respawnable
    return null
  }

  private async reserveSlot(signature: string) {
    return await this.withAllocationLock(() => {
      const slot = this.pickSlot(signature)
      if (!slot) {
        throw createWorkerError(
          'PERSISTENT_XPU_WORKER_BUSY',
          '全部 XPU 常驻 worker 正忙，回退旧路径'
        )
      }
      slot.reserve()
      return slot
    })
  }

  async runInference(params: RunPersistentXpuStemInferenceParams) {
    if (params.payload.device !== 'xpu') {
      throw createWorkerError('PERSISTENT_XPU_WORKER_INVALID_DEVICE', '仅支持 xpu 设备')
    }
    this.ensureWindowHooks()
    const signature = this.buildSignature(params)
    const slot = await this.reserveSlot(signature)
    await slot.runInference(params, signature)
  }

  stopAll(reason: string) {
    for (const slot of this.slots) {
      slot.stopWorker(reason)
    }
  }
}

const manager = new PersistentXpuStemWorkerManager()

export const runPersistentXpuStemInference = async (
  params: RunPersistentXpuStemInferenceParams
) => {
  await manager.runInference(params)
}

export const stopPersistentXpuStemWorker = (reason: string) => {
  manager.stopAll(reason)
}
