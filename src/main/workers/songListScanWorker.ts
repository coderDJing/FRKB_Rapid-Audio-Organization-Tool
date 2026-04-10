import { parentPort } from 'node:worker_threads'
import store from '../store'
import { scanSongList } from '../services/scanSongs'

type WorkerRequest = {
  scanPath: string | string[]
  audioExt: string[]
  songListUUID: string
  databaseDir: string
}

parentPort?.on('message', async (payload: WorkerRequest) => {
  try {
    store.databaseDir = String(payload?.databaseDir || '').trim()
    const result = await scanSongList(
      payload?.scanPath || '',
      Array.isArray(payload?.audioExt) ? payload.audioExt : [],
      String(payload?.songListUUID || '').trim(),
      {
        enablePostScanTasks: false
      }
    )
    parentPort?.postMessage({ result })
  } catch (error) {
    parentPort?.postMessage({
      error: error instanceof Error ? error.message : String(error || 'scanSongList worker failed')
    })
  }
})
