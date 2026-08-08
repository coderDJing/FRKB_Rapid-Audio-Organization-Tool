export type CoverDisplayWorkerResult = {
  data: Uint8Array
  format: string
  sourceBytes: number
  outputBytes: number
  resized: boolean
}

type PendingRequest = {
  resolve: (result: CoverDisplayWorkerResult) => void
  reject: (error: Error) => void
}

type WorkerResponse = Omit<CoverDisplayWorkerResult, 'data'> & {
  requestId: number
  data: ArrayBuffer
}

export function createCoverDisplayWorkerClient() {
  const worker = new Worker(new URL('./coverDisplay.worker.ts', import.meta.url), {
    type: 'module'
  })
  const pending = new Map<number, PendingRequest>()
  let nextRequestId = 0
  let disposed = false

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data
    const request = pending.get(response.requestId)
    if (!request) return
    pending.delete(response.requestId)
    request.resolve({
      data: new Uint8Array(response.data),
      format: response.format,
      sourceBytes: response.sourceBytes,
      outputBytes: response.outputBytes,
      resized: response.resized
    })
  }

  worker.onerror = () => {
    disposed = true
    worker.terminate()
    const error = new Error('cover display worker failed')
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  const resize = (data: Uint8Array, format: string, maxEdge: number = 256) => {
    if (disposed) return Promise.reject(new Error('cover display worker disposed'))
    const requestId = ++nextRequestId
    const transferable = new Uint8Array(data.byteLength)
    transferable.set(data)
    return new Promise<CoverDisplayWorkerResult>((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      worker.postMessage(
        {
          requestId,
          data: transferable.buffer,
          format,
          maxEdge
        },
        [transferable.buffer]
      )
    })
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    worker.terminate()
    const error = new Error('cover display worker disposed')
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  return { resize, dispose }
}
