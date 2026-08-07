import { parentPort } from 'node:worker_threads'
import { probeAudioTimeBasisOffsetMs } from '../services/audioTimeBasisOffsetProbe'

type WorkerRequest = {
  requestId: number
  ffprobePath: string
  filePath: string
}

parentPort?.on('message', async (request: WorkerRequest) => {
  const result = await probeAudioTimeBasisOffsetMs(request.ffprobePath, request.filePath)
  parentPort?.postMessage({ requestId: request.requestId, ...result })
})
