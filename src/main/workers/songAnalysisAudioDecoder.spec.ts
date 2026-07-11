import { describe, expect, it, vi } from 'vitest'
import {
  SONG_ANALYSIS_NATIVE_LIBAV_BACKEND,
  SONG_ANALYSIS_WAVEFORM_CHANNELS,
  SONG_ANALYSIS_WAVEFORM_SAMPLE_RATE,
  decodeSongAnalysisAudio,
  shouldUseNativeLibavSongAnalysisDecode,
  type SongAnalysisAudioDecoderBinding
} from './songAnalysisAudioDecoder'

const createDecodedAudio = () => ({
  pcmData: Buffer.from([1, 2, 3, 4]),
  sampleRate: 48000,
  channels: 1,
  totalFrames: 4
})

describe('songAnalysisAudioDecoder', () => {
  it('uses native libav with the production waveform format for MP3 files', () => {
    const decodeAudioFile = vi.fn(() => createDecodedAudio())
    const decodeAudioFileNativePcm = vi.fn(() => createDecodedAudio())
    const binding: SongAnalysisAudioDecoderBinding = {
      decodeAudioFile,
      decodeAudioFileNativePcm
    }

    const decoded = decodeSongAnalysisAudio(binding, 'D:/music/Track.MP3')

    expect(shouldUseNativeLibavSongAnalysisDecode('D:/music/Track.MP3')).toBe(true)
    expect(decodeAudioFile).not.toHaveBeenCalled()
    expect(decodeAudioFileNativePcm).toHaveBeenCalledWith(
      'D:/music/Track.MP3',
      null,
      null,
      SONG_ANALYSIS_WAVEFORM_SAMPLE_RATE,
      SONG_ANALYSIS_WAVEFORM_CHANNELS
    )
    expect(decoded.decoderBackend).toBe(SONG_ANALYSIS_NATIVE_LIBAV_BACKEND)
  })

  it('keeps the default decoder for non-MP3 files', () => {
    const decodeAudioFile = vi.fn(() => createDecodedAudio())
    const decodeAudioFileNativePcm = vi.fn(() => createDecodedAudio())
    const binding: SongAnalysisAudioDecoderBinding = {
      decodeAudioFile,
      decodeAudioFileNativePcm
    }

    const decoded = decodeSongAnalysisAudio(binding, 'D:/music/Track.wav')

    expect(shouldUseNativeLibavSongAnalysisDecode('D:/music/Track.wav')).toBe(false)
    expect(decodeAudioFile).toHaveBeenCalledWith('D:/music/Track.wav')
    expect(decodeAudioFileNativePcm).not.toHaveBeenCalled()
    expect(decoded.decoderBackend).toBeUndefined()
  })

  it('does not silently fall back when the production MP3 decoder is unavailable', () => {
    const binding: SongAnalysisAudioDecoderBinding = {
      decodeAudioFile: vi.fn(() => createDecodedAudio())
    }

    expect(() => decodeSongAnalysisAudio(binding, 'D:/music/Track.mp3')).toThrow(
      'decodeAudioFileNativePcm unavailable'
    )
  })
})
