import fs from 'node:fs/promises'

const WAVEFORM_COLUMNS = 320
const FRAMES_PER_COLUMN = 512

type WavFormat = {
  format: number
  channels: number
  bitsPerSample: number
  blockAlign: number
  dataOffset: number
  dataBytes: number
}

export type LibraryStemPreviewWaveform = {
  peaks: number[]
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const readWavFormat = async (filePath: string): Promise<WavFormat | null> => {
  const handle = await fs.open(filePath, 'r')
  try {
    const header = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead < 20 || header.subarray(0, 4).toString('ascii') !== 'RIFF') return null
    if (header.subarray(8, 12).toString('ascii') !== 'WAVE') return null

    let format: Omit<WavFormat, 'dataOffset' | 'dataBytes'> | null = null
    let offset = 12
    while (offset + 8 <= bytesRead) {
      const chunkId = header.subarray(offset, offset + 4).toString('ascii')
      const chunkSize = header.readUInt32LE(offset + 4)
      const dataOffset = offset + 8
      const nextOffset = dataOffset + chunkSize + (chunkSize % 2)

      if (chunkId === 'data' && format) {
        return {
          ...format,
          dataOffset,
          dataBytes: chunkSize
        }
      }
      if (nextOffset > bytesRead) return null

      if (chunkId === 'fmt ' && chunkSize >= 16) {
        const rawFormat = header.readUInt16LE(dataOffset)
        const extensibleSubformat =
          rawFormat === 0xfffe && chunkSize >= 40 ? header.readUInt16LE(dataOffset + 24) : rawFormat
        const channels = header.readUInt16LE(dataOffset + 2)
        const blockAlign = header.readUInt16LE(dataOffset + 12)
        const bitsPerSample = header.readUInt16LE(dataOffset + 14)
        if (channels > 0 && blockAlign > 0 && bitsPerSample > 0) {
          format = {
            format: extensibleSubformat,
            channels,
            bitsPerSample,
            blockAlign
          }
        }
      }

      offset = nextOffset
    }
    return null
  } finally {
    await handle.close()
  }
}

const readSample = (buffer: Buffer, offset: number, format: WavFormat): number => {
  const { bitsPerSample, format: wavFormat } = format
  if (bitsPerSample === 8) return Math.abs((buffer.readUInt8(offset) - 128) / 128)
  if (bitsPerSample === 16) return Math.abs(buffer.readInt16LE(offset) / 32768)
  if (bitsPerSample === 24) return Math.abs(buffer.readIntLE(offset, 3) / 8388608)
  if (bitsPerSample === 32) {
    const value =
      wavFormat === 3 ? buffer.readFloatLE(offset) : buffer.readInt32LE(offset) / 2147483648
    return Number.isFinite(value) ? Math.abs(value) : 0
  }
  if (bitsPerSample === 64 && wavFormat === 3) {
    const value = buffer.readDoubleLE(offset)
    return Number.isFinite(value) ? Math.abs(value) : 0
  }
  return 0
}

export async function readLibraryStemPreviewWaveform(
  filePath: string
): Promise<LibraryStemPreviewWaveform | null> {
  const format = await readWavFormat(filePath)
  if (!format) return null

  const stat = await fs.stat(filePath)
  const availableBytes = Math.max(0, Math.min(format.dataBytes, stat.size - format.dataOffset))
  const totalFrames = Math.floor(availableBytes / format.blockAlign)
  const bytesPerChannel = Math.max(1, Math.floor(format.bitsPerSample / 8))
  if (!totalFrames || format.blockAlign < bytesPerChannel * format.channels) return null

  const handle = await fs.open(filePath, 'r')
  try {
    const peaks: number[] = []
    const buffer = Buffer.alloc(FRAMES_PER_COLUMN * format.blockAlign)
    for (let column = 0; column < WAVEFORM_COLUMNS; column += 1) {
      const centerFrame = Math.floor(((column + 0.5) / WAVEFORM_COLUMNS) * totalFrames)
      const startFrame = clamp(centerFrame - Math.floor(FRAMES_PER_COLUMN / 2), 0, totalFrames - 1)
      const frameCount = Math.min(FRAMES_PER_COLUMN, totalFrames - startFrame)
      const bytesToRead = frameCount * format.blockAlign
      const { bytesRead } = await handle.read(
        buffer,
        0,
        bytesToRead,
        format.dataOffset + startFrame * format.blockAlign
      )
      let energy = 0
      let sampleCount = 0
      for (
        let frameOffset = 0;
        frameOffset + format.blockAlign <= bytesRead;
        frameOffset += format.blockAlign
      ) {
        for (let channel = 0; channel < format.channels; channel += 1) {
          const sampleOffset = frameOffset + channel * bytesPerChannel
          const value = readSample(buffer, sampleOffset, format)
          energy += value * value
          sampleCount += 1
        }
      }
      const rms = sampleCount ? Math.sqrt(energy / sampleCount) : 0
      const level = Math.pow(clamp(rms * 2.8, 0, 1), 0.72)
      peaks.push(Math.round(level * 255) / 255)
    }
    return { peaks }
  } finally {
    await handle.close()
  }
}
