import { ipcMain, type BrowserWindow } from 'electron'

const clonePcmData = (pcmData: unknown): Float32Array => {
  if (!pcmData) {
    return new Float32Array(0)
  }
  if (pcmData instanceof Float32Array) {
    return new Float32Array(pcmData)
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(pcmData)) {
    const buffer = pcmData as Buffer
    const view = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      Math.floor(buffer.byteLength / 4)
    )
    return new Float32Array(view)
  }
  if (pcmData instanceof Uint8Array) {
    const view = new Float32Array(
      pcmData.buffer,
      pcmData.byteOffset,
      Math.floor(pcmData.byteLength / 4)
    )
    return new Float32Array(view)
  }
  return new Float32Array(0)
}

export function registerAudioDecodeHandlers(getWindow: () => BrowserWindow | null) {
  const handleDecode =
    (eventName: 'readSongFile' | 'readNextSongFile', successEvent: string, errorEvent: string) =>
    async (_e: Electron.IpcMainEvent, filePath: string, requestId: string) => {
      try {
        const { decodeAudioFile } = require('rust_package')
        const result = decodeAudioFile(filePath)
        if (result.error) {
          throw new Error(result.error)
        }
        const payload = {
          pcmData: clonePcmData(result.pcmData),
          sampleRate: result.sampleRate,
          channels: result.channels,
          totalFrames: result.totalFrames
        }
        getWindow()?.webContents.send(successEvent, payload, filePath, requestId)
      } catch (error) {
        console.error(`解码歌曲文件失败(${eventName}) ${filePath}:`, error)
        getWindow()?.webContents.send(errorEvent, filePath, (error as Error).message, requestId)
      }
    }

  ipcMain.on('readSongFile', handleDecode('readSongFile', 'readedSongFile', 'readSongFileError'))
  ipcMain.on(
    'readNextSongFile',
    handleDecode('readNextSongFile', 'readedNextSongFile', 'readNextSongFileError')
  )
}
