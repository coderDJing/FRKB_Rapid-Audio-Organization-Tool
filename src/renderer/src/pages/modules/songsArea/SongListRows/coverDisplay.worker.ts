type ResizeCoverRequest = {
  requestId: number
  data: ArrayBuffer
  format: string
  maxEdge: number
}

type ResizeCoverResponse = {
  requestId: number
  data: ArrayBuffer
  format: string
  sourceBytes: number
  outputBytes: number
  resized: boolean
}

const respond = (response: ResizeCoverResponse) => {
  self.postMessage(response, { transfer: [response.data] })
}

self.onmessage = async (event: MessageEvent<ResizeCoverRequest>) => {
  const { requestId, data, format, maxEdge } = event.data
  const sourceBytes = data.byteLength
  try {
    const bitmap = await createImageBitmap(new Blob([data], { type: format || 'image/jpeg' }))
    const sourceMaxEdge = Math.max(bitmap.width, bitmap.height)
    const targetMaxEdge = Math.max(48, Math.min(256, Math.round(maxEdge)))
    if (sourceMaxEdge <= targetMaxEdge) {
      bitmap.close()
      respond({
        requestId,
        data,
        format: format || 'image/jpeg',
        sourceBytes,
        outputBytes: sourceBytes,
        resized: false
      })
      return
    }
    const scale = targetMaxEdge / sourceMaxEdge
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2d canvas unavailable')
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const preserveAlpha = /png|gif|webp/i.test(format)
    const outputFormat = preserveAlpha ? 'image/png' : 'image/jpeg'
    const outputBlob = await canvas.convertToBlob({
      type: outputFormat,
      quality: preserveAlpha ? undefined : 0.84
    })
    const output = await outputBlob.arrayBuffer()
    respond({
      requestId,
      data: output,
      format: outputFormat,
      sourceBytes,
      outputBytes: output.byteLength,
      resized: true
    })
  } catch {
    respond({
      requestId,
      data,
      format: format || 'image/jpeg',
      sourceBytes,
      outputBytes: sourceBytes,
      resized: false
    })
  }
}
