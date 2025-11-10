export const SUPPORTED_AUDIO_FORMATS = [
  'mp3',
  'wav',
  'flac',
  'aif',
  'aiff',
  'ogg',
  'opus',
  'aac',
  'm4a',
  'mp4',
  'wma',
  'ac3',
  'dts',
  'mka',
  'webm',
  'ape',
  'tak',
  'tta',
  'wv'
] as const

export type SupportedAudioFormat = (typeof SUPPORTED_AUDIO_FORMATS)[number]

export const ENCODER_REQUIREMENTS: Record<SupportedAudioFormat, string[]> = {
  mp3: ['libmp3lame', 'mp3_mf'],
  wav: [],
  flac: ['flac'],
  aif: [],
  aiff: [],
  ogg: ['libvorbis', 'vorbis'],
  opus: ['libopus', 'opus'],
  aac: ['aac', 'aac_mf'],
  m4a: ['aac', 'aac_mf'],
  mp4: ['aac', 'aac_mf'],
  wma: ['wmav2', 'wmav1'],
  ac3: ['ac3', 'ac3_mf'],
  dts: ['dca'],
  mka: ['flac'],
  webm: ['libopus', 'opus'],
  ape: ['ape'],
  tak: ['tak'],
  tta: ['tta'],
  wv: ['wavpack']
}

export const METADATA_PRESERVABLE_FORMATS: SupportedAudioFormat[] = [
  'mp3',
  'flac',
  'wav',
  'aif',
  'aiff',
  'ogg',
  'opus',
  'aac',
  'm4a',
  'mp4',
  'wma',
  'mka',
  'webm',
  'wv'
]
