import type { Worker } from 'node:worker_threads'
import type { MixtapeRawWaveformData } from '../libraryCacheDb/mixtapeRawWaveformCache'

export type MixtapeRawWaveformStreamWorkerPayload = {
  jobId?: number
  filePath?: string
  progress?: {
    type?: string
    startFrame?: number
    frames?: number
    totalFrames?: number
    duration?: number
    sampleRate?: number
    rate?: number
    minLeft?: Uint8Array | Buffer
    maxLeft?: Uint8Array | Buffer
    minRight?: Uint8Array | Buffer
    maxRight?: Uint8Array | Buffer
  }
  result?: {
    rawWaveformData?: MixtapeRawWaveformData
  }
  error?: string
}

export type RawWaveformStreamRequest = {
  requestId: string
  filePath: string
  deckKey: string
  sender: Electron.WebContents
  listRoot: string
  stat: { size: number; mtimeMs: number } | null
  targetRate?: number
  startSec: number
  songDurationSec: number
  chunkFrames: number
  expectedDurationSec: number
  bootstrapDurationSec: number
  priorityHint: number
  protectsPlayback: boolean
  forceLiveDecode: boolean
  enqueuedAt: number
  worker?: Worker
  streamStartedAt?: number
  firstChunkAt?: number
  chunkCount: number
}

export type CachedRawWaveformContinuation = {
  sender: Electron.WebContents
  requestId: string
  filePath: string
  startSec: number
  startFrameOffset: number
  songDurationSec: number
  cached: MixtapeRawWaveformData
  nextStartFrame: number
  followupFramesPerChunk: number
  totalFrames: number
  priorityHint: number
  startedAt: number
  chunkCount: number
  sending: boolean
}

export type LiveRawWaveformBufferedChunk = {
  startFrame: number
  frames: number
  totalFrames: number
  duration: number
  sampleRate: number
  rate: number
  minLeft: Uint8Array | Buffer
  maxLeft: Uint8Array | Buffer
  minRight: Uint8Array | Buffer
  maxRight: Uint8Array | Buffer
}

export type LiveRawWaveformContinuation = {
  sender: Electron.WebContents
  requestId: string
  filePath: string
  startSec: number
  priorityHint: number
  startedAt: number
  chunkCount: number
  queue: LiveRawWaveformBufferedChunk[]
  continueCredits: number
  donePayload: Record<string, unknown> | null
}

export const MAX_ACTIVE_RAW_WAVEFORM_STREAMS = 2
export const MAX_ACTIVE_RAW_WAVEFORM_STREAMS_PER_DECK = 1
export const MAX_LIVE_RAW_WAVEFORM_CONTINUE_CREDITS = 2
