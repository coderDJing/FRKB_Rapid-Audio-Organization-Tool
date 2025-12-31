export type KeyDisplayMode = 'classic' | 'camelot'

const CAMELOT_MAP: Record<string, string> = {
  C: '8B',
  Cm: '5A',
  'C#': '3B',
  'C#m': '12A',
  Db: '3B',
  Dbm: '12A',
  D: '10B',
  Dm: '7A',
  'D#': '5B',
  'D#m': '2A',
  Eb: '5B',
  Ebm: '2A',
  E: '12B',
  Em: '9A',
  F: '7B',
  Fm: '4A',
  'F#': '2B',
  'F#m': '11A',
  Gb: '2B',
  Gbm: '11A',
  G: '9B',
  Gm: '6A',
  'G#': '4B',
  'G#m': '1A',
  Ab: '4B',
  Abm: '1A',
  A: '11B',
  Am: '8A',
  'A#': '6B',
  'A#m': '3A',
  Bb: '6B',
  Bbm: '3A',
  B: '1B',
  Bm: '10A'
}

const normalizeKeyLabel = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  let rootPart = trimmed
  let modePart = ''
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':')
    rootPart = parts[0] || ''
    modePart = parts.slice(1).join(':')
  } else if (trimmed.includes(' ')) {
    const parts = trimmed.split(/\s+/)
    rootPart = parts[0] || ''
    modePart = parts.slice(1).join(' ')
  }

  const match = rootPart.toLowerCase().match(/^([a-g])([#b]?)(m)?$/)
  if (!match) return trimmed

  const root = `${match[1].toUpperCase()}${match[2] || ''}`
  const modeRaw = (modePart || '').toLowerCase().trim()
  let isMinor: boolean
  if (modeRaw) {
    if (modeRaw.startsWith('min') || modeRaw === 'minor' || modeRaw === 'm') {
      isMinor = true
    } else if (modeRaw.startsWith('maj') || modeRaw === 'major') {
      isMinor = false
    } else {
      isMinor = match[3] === 'm'
    }
  } else {
    isMinor = match[3] === 'm'
  }

  return `${root}${isMinor ? 'm' : ''}`
}

export const formatKeyDisplay = (raw: unknown, mode: KeyDisplayMode): string | null => {
  const normalized = normalizeKeyLabel(raw)
  if (!normalized) return null
  if (mode === 'camelot') return CAMELOT_MAP[normalized] ?? normalized
  return normalized
}
