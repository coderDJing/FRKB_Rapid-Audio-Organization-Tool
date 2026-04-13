export const BPM_INTERNAL_DECIMALS = 6
export const BPM_DISPLAY_DECIMALS = 2

const BPM_DISPLAY_SCALE = 10 ** BPM_DISPLAY_DECIMALS

const normalizePositiveBpm = (value: unknown): number | null => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Number(numeric.toFixed(BPM_INTERNAL_DECIMALS))
}

export const normalizeBpmDisplayScaled = (value: unknown): number | null => {
  const normalized = normalizePositiveBpm(value)
  if (normalized === null) return null

  const [integerPartRaw, fractionPartRaw = ''] = normalized
    .toFixed(BPM_INTERNAL_DECIMALS)
    .split('.')
  const integerPart = Number(integerPartRaw)
  const fractionPart = fractionPartRaw.padEnd(BPM_INTERNAL_DECIMALS, '0')
  const preservedDigits = Number(fractionPart.slice(0, BPM_DISPLAY_DECIMALS) || '0')
  const thirdDigit = Number(fractionPart.charAt(BPM_DISPLAY_DECIMALS) || '0')

  let scaled = integerPart * BPM_DISPLAY_SCALE + preservedDigits
  if (thirdDigit >= 6) {
    scaled += 1
  }
  return scaled
}

export const formatBpmDisplay = (value: unknown, fallback: string = 'N/A') => {
  const scaled = normalizeBpmDisplayScaled(value)
  if (scaled === null) return fallback
  return (scaled / BPM_DISPLAY_SCALE).toFixed(BPM_DISPLAY_DECIMALS)
}
