const DIGIT_CODE_PATTERN = /^(?:Digit|Numpad)([0-9])$/

const resolveDigitRatio = (digit: string) => {
  if (digit === '0') return 1
  const value = Number(digit)
  if (!Number.isInteger(value) || value < 1 || value > 9) return null
  return value / 10
}

export const resolveSeekPercentHotkeyRatio = (
  event: Pick<KeyboardEvent, 'key' | 'code'>,
  handlerKey?: string
) => {
  const code = String(event.code || '')
  const key = String(event.key || '')
  if (code === 'Backquote' || key === '`' || key === '~') return 0

  const fromCode = DIGIT_CODE_PATTERN.exec(code)
  if (fromCode) return resolveDigitRatio(fromCode[1])

  if (/^[0-9]$/.test(key)) return resolveDigitRatio(key)

  const raw = String(handlerKey || '').trim()
  if (raw === '`') return 0
  if (/^[0-9]$/.test(raw)) return resolveDigitRatio(raw)
  return null
}
