import { parentPort } from 'node:worker_threads'
import { collectFilesWithExtensions } from '../nodeTaskUtils'

type CountWorkerRequest = {
  scanPath?: string
  audioExt?: string[]
}

parentPort?.on('message', async (payload: CountWorkerRequest) => {
  try {
    const scanPath = String(payload?.scanPath || '').trim()
    const audioExt = Array.isArray(payload?.audioExt) ? payload.audioExt : []
    if (!scanPath) {
      parentPort?.postMessage({ count: 0 })
      return
    }
    const files = await collectFilesWithExtensions(scanPath, audioExt)
    parentPort?.postMessage({ count: files.length })
  } catch (error) {
    parentPort?.postMessage({
      error:
        error instanceof Error ? error.message : String(error || 'songListTrackCount worker failed')
    })
  }
})
