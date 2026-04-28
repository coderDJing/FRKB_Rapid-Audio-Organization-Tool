import fs from 'node:fs'
import path from 'node:path'
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  buildBeatThisChildEnv,
  normalizeBeatThisFsPath,
  resolveBeatThisProjectRoot,
  resolveBeatThisRuntime
} from './beatThisRuntime'
import type { BeatGridAnalyzeParams, BeatGridAnalyzeResult } from './beatGridAnalyzerTypes'

type BeatThisAnalyzeResult = Omit<BeatGridAnalyzeResult, 'analyzerProvider'>

type BeatThisBridgeMessage =
  | {
      type: 'ready'
    }
  | {
      type: 'result'
      requestId: string
      result: BeatThisAnalyzeResult
    }
  | {
      type: 'error' | 'fatal'
      requestId?: string
      error?: string
    }
  | {
      type: 'shutdown'
      requestId?: string
    }

type PendingRequest = {
  resolve: (value: BeatGridAnalyzeResult) => void
  reject: (error: Error) => void
}

const ENV_BEAT_THIS_BRIDGE = 'FRKB_BEAT_THIS_BRIDGE'
const ENV_BEAT_THIS_DBN = 'FRKB_BEAT_THIS_DBN'
const LOCAL_BRIDGE_PATH = 'scripts/beat_this_bridge.py'
const PACKAGED_BRIDGE_RELATIVE_PATH = 'demucs/bootstrap/beat_this_bridge.py'
const DEFAULT_WINDOW_SEC = 30
const DEFAULT_MAX_SCAN_SEC = 120
const WINDOW_MIN_DURATION_SEC = 8

let cachedBridgePath = ''
let bridgeChild: ChildProcessWithoutNullStreams | null = null
let bridgeReadyPromise: Promise<void> | null = null
let bridgeReadyResolve: (() => void) | null = null
let bridgeReadyReject: ((error: Error) => void) | null = null
let bridgeStdoutBuffer = ''
let bridgeStderrBuffer = ''
let bridgeNextRequestId = 0
let bridgeRequestQueue: Promise<unknown> = Promise.resolve()
const bridgePendingRequests = new Map<string, PendingRequest>()
let cleanupHooksRegistered = false

const resolveBridgeScriptPath = () => {
  if (cachedBridgePath) return cachedBridgePath

  const envBridge = normalizeBeatThisFsPath(process.env[ENV_BEAT_THIS_BRIDGE] || '')
  if (envBridge && fs.existsSync(envBridge)) {
    cachedBridgePath = envBridge
    return envBridge
  }

  const packagedBridge = normalizeBeatThisFsPath(
    path.join(normalizeBeatThisFsPath(process.resourcesPath || ''), PACKAGED_BRIDGE_RELATIVE_PATH)
  )
  if (packagedBridge && fs.existsSync(packagedBridge)) {
    cachedBridgePath = packagedBridge
    return packagedBridge
  }

  const unpackedBridge = normalizeBeatThisFsPath(
    path.join(
      normalizeBeatThisFsPath(process.resourcesPath || ''),
      'app.asar.unpacked',
      LOCAL_BRIDGE_PATH
    )
  )
  if (unpackedBridge && fs.existsSync(unpackedBridge)) {
    cachedBridgePath = unpackedBridge
    return unpackedBridge
  }

  const localBridge = path.join(resolveBeatThisProjectRoot(), LOCAL_BRIDGE_PATH)
  cachedBridgePath = localBridge
  return localBridge
}

const normalizeBeatThisResult = (input: BeatThisAnalyzeResult): BeatGridAnalyzeResult | null => {
  const bpm = Number(input?.bpm)
  const rawBpm = Number(input?.rawBpm)
  const firstBeatMs = Number(input?.firstBeatMs)
  const rawBarBeatOffset = Number(input?.barBeatOffset)
  const beatCount = Math.max(0, Math.floor(Number(input?.beatCount) || 0))
  const downbeatCount = Math.max(0, Math.floor(Number(input?.downbeatCount) || 0))
  const durationSec = Math.max(0, Number(input?.durationSec) || 0)
  const beatIntervalSec = Math.max(0, Number(input?.beatIntervalSec) || 0)
  const beatCoverageScore = Math.max(0, Math.min(1, Number(input?.beatCoverageScore) || 0))
  const beatStabilityScore = Math.max(0, Math.min(1, Number(input?.beatStabilityScore) || 0))
  const downbeatCoverageScore = Math.max(0, Math.min(1, Number(input?.downbeatCoverageScore) || 0))
  const downbeatStabilityScore = Math.max(
    0,
    Math.min(1, Number(input?.downbeatStabilityScore) || 0)
  )
  const qualityScore = Math.max(0, Math.min(1, Number(input?.qualityScore) || 0))
  const rawFirstBeatMs = Number(input?.rawFirstBeatMs)
  const anchorCorrectionMs = Number(input?.anchorCorrectionMs)
  const anchorConfidenceScore = Math.max(0, Math.min(1, Number(input?.anchorConfidenceScore) || 0))
  const anchorMatchedBeatCount = Math.max(0, Math.floor(Number(input?.anchorMatchedBeatCount) || 0))
  const anchorStrategy = String(input?.anchorStrategy || '').trim()
  const beatThisEstimatedDrift128Ms = Number(input?.beatThisEstimatedDrift128Ms)
  const beatThisWindowCount = Math.max(0, Math.floor(Number(input?.beatThisWindowCount) || 0))

  if (!Number.isFinite(bpm) || bpm <= 0) return null
  if (!Number.isFinite(firstBeatMs)) return null

  return {
    analyzerProvider: 'beatthis',
    bpm: Number(bpm.toFixed(6)),
    rawBpm: Number.isFinite(rawBpm) && rawBpm > 0 ? Number(rawBpm.toFixed(6)) : undefined,
    firstBeatMs: Number(firstBeatMs.toFixed(3)),
    barBeatOffset: Number.isFinite(rawBarBeatOffset)
      ? ((Math.round(rawBarBeatOffset) % 32) + 32) % 32
      : 0,
    beatCount,
    downbeatCount,
    durationSec: Number(durationSec.toFixed(3)),
    beatIntervalSec: Number(beatIntervalSec.toFixed(6)),
    beatCoverageScore: Number(beatCoverageScore.toFixed(6)),
    beatStabilityScore: Number(beatStabilityScore.toFixed(6)),
    downbeatCoverageScore: Number(downbeatCoverageScore.toFixed(6)),
    downbeatStabilityScore: Number(downbeatStabilityScore.toFixed(6)),
    qualityScore: Number(qualityScore.toFixed(6)),
    rawFirstBeatMs: Number.isFinite(rawFirstBeatMs) ? Number(rawFirstBeatMs.toFixed(3)) : undefined,
    anchorCorrectionMs: Number.isFinite(anchorCorrectionMs)
      ? Number(anchorCorrectionMs.toFixed(3))
      : undefined,
    anchorConfidenceScore: Number(anchorConfidenceScore.toFixed(6)),
    anchorMatchedBeatCount,
    anchorStrategy: anchorStrategy || undefined,
    beatThisEstimatedDrift128Ms: Number.isFinite(beatThisEstimatedDrift128Ms)
      ? Number(beatThisEstimatedDrift128Ms.toFixed(3))
      : undefined,
    beatThisWindowCount: beatThisWindowCount > 0 ? beatThisWindowCount : undefined,
    windowStartSec: Number(Number(input?.windowStartSec || 0).toFixed(3)),
    windowDurationSec: Number(Number(input?.windowDurationSec || 0).toFixed(3)),
    windowIndex: Math.max(0, Math.floor(Number(input?.windowIndex) || 0))
  }
}

const settleBridgeReady = (error?: Error) => {
  if (error) {
    bridgeReadyReject?.(error)
  } else {
    bridgeReadyResolve?.()
  }
  bridgeReadyResolve = null
  bridgeReadyReject = null
}

const rejectAllPendingRequests = (error: Error) => {
  for (const pending of bridgePendingRequests.values()) {
    pending.reject(error)
  }
  bridgePendingRequests.clear()
}

const resetBridgeProcessState = (error?: Error) => {
  bridgeChild = null
  bridgeStdoutBuffer = ''
  bridgeStderrBuffer = ''
  if (bridgeReadyResolve || bridgeReadyReject) {
    settleBridgeReady(error || new Error('Beat This! bridge terminated before ready'))
  }
  bridgeReadyPromise = null
  rejectAllPendingRequests(error || new Error('Beat This! bridge terminated'))
}

const registerCleanupHooks = () => {
  if (cleanupHooksRegistered) return
  cleanupHooksRegistered = true
  const shutdown = () => {
    if (!bridgeChild) return
    try {
      bridgeChild.kill()
    } catch {}
  }
  process.once('exit', shutdown)
  process.once('SIGINT', () => {
    shutdown()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    shutdown()
    process.exit(143)
  })
}

const handleBridgeMessage = (message: BeatThisBridgeMessage) => {
  if (message.type === 'ready') {
    settleBridgeReady()
    return
  }

  if (message.type === 'fatal') {
    const error = new Error(message.error || 'Beat This! bridge fatal error')
    if (bridgeReadyResolve || bridgeReadyReject) {
      settleBridgeReady(error)
    } else {
      rejectAllPendingRequests(error)
    }
    return
  }

  const requestId = String(message.requestId || '').trim()
  if (!requestId) return
  const pending = bridgePendingRequests.get(requestId)
  if (!pending) return
  bridgePendingRequests.delete(requestId)

  if (message.type === 'result') {
    const normalized = normalizeBeatThisResult(message.result)
    if (!normalized) {
      pending.reject(new Error('Beat This! returned invalid beat grid result'))
      return
    }
    pending.resolve(normalized)
    return
  }

  const errorText = 'error' in message ? message.error : undefined
  pending.reject(new Error(errorText || 'Beat This! bridge request ended unexpectedly'))
}

const handleBridgeStdoutChunk = (chunk: Buffer | string) => {
  bridgeStdoutBuffer += chunk.toString()
  while (true) {
    const lineBreakIndex = bridgeStdoutBuffer.indexOf('\n')
    if (lineBreakIndex < 0) return
    const line = bridgeStdoutBuffer.slice(0, lineBreakIndex).trim()
    bridgeStdoutBuffer = bridgeStdoutBuffer.slice(lineBreakIndex + 1)
    if (!line) continue
    try {
      handleBridgeMessage(JSON.parse(line) as BeatThisBridgeMessage)
    } catch (error) {
      const parseError = new Error(
        `Beat This! bridge returned invalid JSON: ${
          error instanceof Error ? error.message : String(error || 'unknown parse error')
        }`
      )
      if (bridgeReadyResolve || bridgeReadyReject) {
        settleBridgeReady(parseError)
      } else {
        rejectAllPendingRequests(parseError)
      }
    }
  }
}

const ensureBridgeProcess = async () => {
  if (bridgeChild && bridgeReadyPromise) {
    await bridgeReadyPromise
    return bridgeChild
  }

  const resolvedRuntime = resolveBeatThisRuntime()
  if (!resolvedRuntime) {
    throw new Error('Beat This! Python runtime not available')
  }
  const pythonCommand = resolvedRuntime.candidate

  const bridgePath = resolveBridgeScriptPath()
  if (!bridgePath || !fs.existsSync(bridgePath)) {
    throw new Error(`Beat This! bridge missing: ${bridgePath || '<empty>'}`)
  }

  const device = resolvedRuntime.selectedDeviceArg || 'cpu'
  const dbnEnabled = /^(1|true|yes|on)$/i.test(String(process.env[ENV_BEAT_THIS_DBN] || '').trim())
  const child = childProcess.spawn(
    pythonCommand.command,
    [...pythonCommand.args, bridgePath, '--serve', device, dbnEnabled ? 'true' : 'false'],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildBeatThisChildEnv(pythonCommand)
    }
  )

  bridgeChild = child
  registerCleanupHooks()
  bridgeReadyPromise = new Promise<void>((resolve, reject) => {
    bridgeReadyResolve = resolve
    bridgeReadyReject = reject
  })

  child.stdout.on('data', handleBridgeStdoutChunk)
  child.stderr.on('data', (chunk: Buffer | string) => {
    bridgeStderrBuffer += chunk.toString()
    if (bridgeStderrBuffer.length > 4000) {
      bridgeStderrBuffer = bridgeStderrBuffer.slice(-4000)
    }
  })
  child.once('error', (error) => {
    const startupError = new Error(
      `Beat This! bridge process failed: ${error instanceof Error ? error.message : String(error)}`
    )
    resetBridgeProcessState(startupError)
  })
  child.once('exit', (code, signal) => {
    const stderrTail = bridgeStderrBuffer.trim()
    const exitError = new Error(
      `Beat This! bridge exited unexpectedly (code=${String(code ?? '')}, signal=${String(signal ?? '')})${
        stderrTail ? ` stderr=${stderrTail}` : ''
      }`
    )
    resetBridgeProcessState(exitError)
  })

  await bridgeReadyPromise
  return child
}

export const preloadBeatThisAnalyzer = async () => {
  await ensureBridgeProcess()
}

export const disposeBeatThisAnalyzer = () => {
  if (!bridgeChild) return
  try {
    bridgeChild.kill()
  } catch {}
  resetBridgeProcessState(new Error('Beat This! bridge disposed'))
}

const writeToBridge = async (child: ChildProcessWithoutNullStreams, chunk: Buffer | string) => {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      child.stdin.off('error', handleError)
      reject(error)
    }
    child.stdin.once('error', handleError)
    const flushed = child.stdin.write(chunk, (error) => {
      child.stdin.off('error', handleError)
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
    if (!flushed) {
      child.stdin.once('drain', () => {})
    }
  })
}

export const analyzeBeatGridWithBeatThisFromPcm = async (
  params: BeatGridAnalyzeParams
): Promise<BeatGridAnalyzeResult> => {
  const pcmData = Buffer.isBuffer(params.pcmData) ? params.pcmData : Buffer.from(params.pcmData)
  const totalSamples = Math.floor(pcmData.byteLength / 4)
  const channels = Math.max(1, Math.floor(Number(params.channels) || 0))
  const usableSamples = totalSamples - (totalSamples % channels)
  if (usableSamples <= 0) {
    throw new Error('decoded PCM is empty')
  }

  const runRequest = bridgeRequestQueue
    .catch(() => undefined)
    .then(async () => {
      const child = await ensureBridgeProcess()
      const requestId = `req-${Date.now()}-${++bridgeNextRequestId}`
      const pcmSlice =
        usableSamples * 4 === pcmData.byteLength ? pcmData : pcmData.subarray(0, usableSamples * 4)
      const header = JSON.stringify({
        type: 'analyze_pcm',
        requestId,
        sampleRate: Math.max(1, Math.floor(Number(params.sampleRate) || 0)),
        channels,
        byteLength: pcmSlice.byteLength,
        sourceFilePath: params.sourceFilePath || '',
        windowSec: Math.max(1, Number(params.windowSec) || DEFAULT_WINDOW_SEC),
        maxScanSec: Math.max(
          Math.max(1, Number(params.windowSec) || DEFAULT_WINDOW_SEC),
          Number(params.maxScanSec) || DEFAULT_MAX_SCAN_SEC
        )
      })

      const response = new Promise<BeatGridAnalyzeResult>((resolve, reject) => {
        bridgePendingRequests.set(requestId, { resolve, reject })
      })

      try {
        await writeToBridge(child, `${header}\n`)
        await writeToBridge(child, pcmSlice)
        return await response
      } catch (error) {
        bridgePendingRequests.delete(requestId)
        throw error
      }
    })
  bridgeRequestQueue = runRequest.catch(() => undefined)
  return runRequest
}

export const analyzeBeatGridWithBeatThisSlidingWindowsFromPcm = async (
  params: BeatGridAnalyzeParams
): Promise<BeatGridAnalyzeResult> => {
  const pcmData = Buffer.isBuffer(params.pcmData) ? params.pcmData : Buffer.from(params.pcmData)
  const sampleRate = Math.max(1, Math.floor(Number(params.sampleRate) || 0))
  const channels = Math.max(1, Math.floor(Number(params.channels) || 0))
  const totalSamples = Math.floor(pcmData.byteLength / 4)
  const totalFrames = Math.floor(totalSamples / channels)
  const totalDurationSec = totalFrames / sampleRate
  const windowSec = Math.max(1, Number(params.windowSec) || DEFAULT_WINDOW_SEC)
  const maxScanSec = Math.max(windowSec, Number(params.maxScanSec) || DEFAULT_MAX_SCAN_SEC)
  if (Math.min(totalDurationSec, maxScanSec) < WINDOW_MIN_DURATION_SEC) {
    throw new Error('Beat This! sliding-window analysis failed')
  }
  return analyzeBeatGridWithBeatThisFromPcm({
    pcmData,
    sampleRate,
    channels,
    sourceFilePath: params.sourceFilePath,
    windowSec,
    maxScanSec
  })
}
