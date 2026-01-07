export type KeyDisplayStyle = 'Classic' | 'Camelot'

const KEY_TO_CAMELOT: Record<string, string> = {
  C: '8B',
  Db: '3B',
  D: '10B',
  Eb: '5B',
  E: '12B',
  F: '7B',
  'F#': '2B',
  G: '9B',
  Ab: '4B',
  A: '11B',
  Bb: '6B',
  B: '1B',
  Cm: '5A',
  'C#m': '12A',
  Dm: '7A',
  Ebm: '2A',
  Em: '9A',
  Fm: '4A',
  'F#m': '11A',
  Gm: '6A',
  'G#m': '1A',
  Am: '8A',
  Bbm: '3A',
  Bm: '10A'
}

export const mapKeyToCamelot = (keyText: string): string => {
  return KEY_TO_CAMELOT[keyText] || keyText
}

export const getKeyDisplayText = (keyText: string, style: KeyDisplayStyle): string => {
  const normalized = typeof keyText === 'string' ? keyText.trim() : ''
  if (!normalized) return ''
  if (style === 'Camelot') {
    return mapKeyToCamelot(normalized)
  }
  return normalized
}

export const getKeySortText = (keyText: string, style: KeyDisplayStyle): string => {
  const display = getKeyDisplayText(keyText, style)
  if (!display) return ''
  if (display.toLowerCase() === 'o') return ''
  if (style === 'Camelot') {
    if (/^\d{1,2}[AB]$/.test(display)) return display
    return `99Z-${display}`
  }
  return display
}
