export const formatBpmLabel = (raw: unknown): string | null => {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const value = raw
  const abs = Math.abs(value)
  const firstDigit = Math.floor((abs + 1e-6) * 10) % 10

  if (firstDigit >= 9) {
    return String(Math.round(value))
  }
  if (firstDigit <= 1) {
    const intValue = value >= 0 ? Math.floor(value) : Math.ceil(value)
    return String(intValue)
  }

  const rounded = Math.round(value * 10) / 10
  return rounded.toFixed(1)
}
