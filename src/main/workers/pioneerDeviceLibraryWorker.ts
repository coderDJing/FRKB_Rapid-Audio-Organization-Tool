import { parentPort } from 'node:worker_threads'

type WorkerRequest =
  | {
      jobId: number
      type: 'read-playlist-tree'
      exportPdbPath: string
    }
  | {
      jobId: number
      type: 'read-playlist-tracks'
      exportPdbPath: string
      playlistId: number
    }
  | {
      jobId: number
      type: 'read-preview-waveforms'
      analyzeFilePaths: string[]
    }

type WorkerResponse = {
  jobId: number
  type: WorkerRequest['type']
  progress?: unknown
  result?: unknown
  error?: string
}

const loadRust = () => {
  return require('rust_package') as {
    readPioneerPlaylistTree?: (exportPdbPath: string) => unknown
    readPioneerPlaylistTracks?: (exportPdbPath: string, playlistId: number) => unknown
    readPioneerPreviewWaveform?: (analyzeFilePath: string) => unknown
  }
}

const respond = (payload: WorkerResponse) => {
  parentPort?.postMessage(payload)
}

parentPort?.on('message', (request: WorkerRequest) => {
  const rust = loadRust()
  try {
    switch (request.type) {
      case 'read-playlist-tree': {
        if (typeof rust.readPioneerPlaylistTree !== 'function') {
          throw new Error('rust_package.readPioneerPlaylistTree 不可用')
        }
        const result = rust.readPioneerPlaylistTree(request.exportPdbPath)
        respond({
          jobId: request.jobId,
          type: request.type,
          result
        })
        return
      }
      case 'read-playlist-tracks': {
        if (typeof rust.readPioneerPlaylistTracks !== 'function') {
          throw new Error('rust_package.readPioneerPlaylistTracks 不可用')
        }
        const result = rust.readPioneerPlaylistTracks(request.exportPdbPath, request.playlistId)
        respond({
          jobId: request.jobId,
          type: request.type,
          result
        })
        return
      }
      case 'read-preview-waveforms': {
        if (typeof rust.readPioneerPreviewWaveform !== 'function') {
          throw new Error('rust_package.readPioneerPreviewWaveform 不可用')
        }
        for (const analyzeFilePath of request.analyzeFilePaths) {
          const dump = rust.readPioneerPreviewWaveform!(analyzeFilePath)
          respond({
            jobId: request.jobId,
            type: request.type,
            progress: {
              analyzeFilePath,
              dump
            }
          })
        }
        respond({
          jobId: request.jobId,
          type: request.type,
          result: {
            total: request.analyzeFilePaths.length
          }
        })
        return
      }
      default:
        throw new Error(`unknown pioneer worker request: ${(request as any)?.type || 'unknown'}`)
    }
  } catch (error) {
    respond({
      jobId: request.jobId,
      type: request.type,
      error: error instanceof Error ? error.message : String(error || 'unknown error')
    })
  }
})
