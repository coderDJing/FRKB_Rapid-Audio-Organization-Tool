import fs from 'node:fs'
import { Worker } from 'node:worker_threads'
import { resolveMainWorkerPath } from '../../workerPath'
import { inspectLibraryMergeSource } from './inspection'
import {
  LibraryMergeError,
  type LibraryMergeDuplicatePlaylistPolicy,
  type LibraryMergePlanSummary,
  type LibraryMergeScope
} from './types'

type WorkerRequest = {
  sourceRoot: string
  targetRoot: string
  appVersion?: string
  scope?: LibraryMergeScope
  duplicatePlaylistPolicy?: LibraryMergeDuplicatePlaylistPolicy
}

type WorkerResponse = {
  summary?: LibraryMergePlanSummary
  code?: string
  error?: string
}

export class LibraryMergeInspectCancelledError extends Error {
  constructor() {
    super('library-merge inspect cancelled')
    this.name = 'LibraryMergeInspectCancelledError'
  }
}

const inspectInWorker = (
  request: WorkerRequest,
  workerPath: string,
  signal?: AbortSignal
): Promise<LibraryMergePlanSummary> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LibraryMergeInspectCancelledError())
      return
    }
    const worker = new Worker(workerPath)
    let settled = false
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      worker.removeAllListeners()
      void worker.terminate()
    }
    const finishResolve = (value: LibraryMergePlanSummary) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const finishReject = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      finishReject(new LibraryMergeInspectCancelledError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (payload: WorkerResponse) => {
      if (payload?.summary) {
        finishResolve(payload.summary)
        return
      }
      if (payload?.code) {
        finishReject(new LibraryMergeError(payload.code, String(payload.error || payload.code)))
        return
      }
      finishReject(
        new Error(String(payload?.error || 'library-merge inspect worker returned empty result'))
      )
    })
    worker.once('error', (error) => {
      finishReject(error instanceof Error ? error : new Error(String(error || 'unknown error')))
    })
    worker.once('exit', (code) => {
      if (settled) return
      finishReject(new Error(`library-merge inspect worker exited: ${String(code ?? '')}`))
    })
    worker.postMessage(request)
  })

/**
 * Source inspection walks trees and may run multi-second SQLite integrity checks.
 * Keep the Electron main thread free so the dialog stays responsive.
 */
export const inspectLibraryMergeSourceOffMainThread = async (params: {
  sourceRoot: string
  targetRoot: string
  appVersion?: string
  scope?: LibraryMergeScope
  duplicatePlaylistPolicy?: LibraryMergeDuplicatePlaylistPolicy
  signal?: AbortSignal
}): Promise<LibraryMergePlanSummary> => {
  if (params.signal?.aborted) {
    throw new LibraryMergeInspectCancelledError()
  }
  const workerPath = resolveMainWorkerPath(__dirname, 'libraryMergeInspectWorker.js')
  if (!fs.existsSync(workerPath)) {
    // Unit tests and unpackaged scripts fall back to the in-process path.
    return inspectLibraryMergeSource(params)
  }
  return inspectInWorker(
    {
      sourceRoot: params.sourceRoot,
      targetRoot: params.targetRoot,
      appVersion: params.appVersion,
      scope: params.scope,
      duplicatePlaylistPolicy: params.duplicatePlaylistPolicy
    },
    workerPath,
    params.signal
  )
}
