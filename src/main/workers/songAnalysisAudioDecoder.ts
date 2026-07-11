import path from 'node:path'

export const SONG_ANALYSIS_WAVEFORM_SAMPLE_RATE = 44100
export const SONG_ANALYSIS_WAVEFORM_CHANNELS = 2
export const SONG_ANALYSIS_NATIVE_LIBAV_BACKEND = 'native-libav-waveform'

export type SongAnalysisDecodedAudio = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
  decoderBackend?: string
  error?: string
}

export type SongAnalysisAudioDecoderBinding = {
  decodeAudioFile: (filePath: string) => SongAnalysisDecodedAudio
  decodeAudioFileNativePcm?: (
    filePath: string,
    startSec: number | null | undefined,
    maxDurationSec: number | null | undefined,
    sampleRate: number,
    channels: number
  ) => SongAnalysisDecodedAudio
}

export const shouldUseNativeLibavSongAnalysisDecode = (filePath: string) =>
  path.extname(filePath || '').toLowerCase() === '.mp3'

const assertDecodedAudio = (
  decoded: SongAnalysisDecodedAudio,
  decoderBackend?: string
): SongAnalysisDecodedAudio => {
  if (decoded.error) throw new Error(decoded.error)
  if (!decoded.pcmData?.byteLength) throw new Error('音频解码结果为空')
  return decoderBackend ? { ...decoded, decoderBackend } : decoded
}

export const decodeSongAnalysisAudio = (
  binding: SongAnalysisAudioDecoderBinding,
  filePath: string
): SongAnalysisDecodedAudio => {
  if (!shouldUseNativeLibavSongAnalysisDecode(filePath)) {
    return assertDecodedAudio(binding.decodeAudioFile(filePath))
  }

  const decodeNative = binding.decodeAudioFileNativePcm
  if (typeof decodeNative !== 'function') {
    throw new Error('decodeAudioFileNativePcm unavailable')
  }
  return assertDecodedAudio(
    decodeNative(
      filePath,
      null,
      null,
      SONG_ANALYSIS_WAVEFORM_SAMPLE_RATE,
      SONG_ANALYSIS_WAVEFORM_CHANNELS
    ),
    SONG_ANALYSIS_NATIVE_LIBAV_BACKEND
  )
}
