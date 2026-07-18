import { parentPort } from 'node:worker_threads'
import { inspectLibraryMergeSource } from '../services/libraryMerge/inspection'
import {
  LibraryMergeError,
  type LibraryMergeDuplicatePlaylistPolicy,
  type LibraryMergeScope
} from '../services/libraryMerge/types'

type WorkerRequest = {
  sourceRoot?: string
  targetRoot?: string
  appVersion?: string
  scope?: LibraryMergeScope
  duplicatePlaylistPolicy?: LibraryMergeDuplicatePlaylistPolicy
}

parentPort?.on('message', async (payload: WorkerRequest) => {
  try {
    const summary = await inspectLibraryMergeSource({
      sourceRoot: String(payload?.sourceRoot || ''),
      targetRoot: String(payload?.targetRoot || ''),
      appVersion: payload?.appVersion,
      scope: payload?.scope,
      duplicatePlaylistPolicy: payload?.duplicatePlaylistPolicy
    })
    parentPort?.postMessage({ summary })
  } catch (error) {
    if (error instanceof LibraryMergeError) {
      parentPort?.postMessage({ code: error.code, error: error.message })
      return
    }
    parentPort?.postMessage({
      error: error instanceof Error ? error.message : String(error || 'inspect worker failed')
    })
  }
})
