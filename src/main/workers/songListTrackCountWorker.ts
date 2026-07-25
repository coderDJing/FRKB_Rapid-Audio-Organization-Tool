import { parentPort } from 'node:worker_threads'
import { collectFilesWithExtensions } from '../nodeTaskUtils'

type CountWorkerRequest = {
  scanPath?: string
  scanPaths?: string[]
  audioExt?: string[]
}

const countOne = async (scanPath: string, audioExt: string[]) => {
  const normalized = String(scanPath || '').trim()
  if (!normalized) return 0
  const files = await collectFilesWithExtensions(normalized, audioExt)
  return files.length
}

parentPort?.on('message', async (payload: CountWorkerRequest) => {
  try {
    const audioExt = Array.isArray(payload?.audioExt) ? payload.audioExt : []
    // 批量模式：一个 worker 顺序遍历多个歌单目录，省掉逐歌单启停 worker 的开销
    if (Array.isArray(payload?.scanPaths)) {
      const counts: number[] = []
      for (const scanPath of payload.scanPaths) {
        counts.push(await countOne(scanPath, audioExt))
      }
      parentPort?.postMessage({ counts })
      return
    }
    parentPort?.postMessage({ count: await countOne(String(payload?.scanPath || ''), audioExt) })
  } catch (error) {
    parentPort?.postMessage({
      error:
        error instanceof Error ? error.message : String(error || 'songListTrackCount worker failed')
    })
  }
})
