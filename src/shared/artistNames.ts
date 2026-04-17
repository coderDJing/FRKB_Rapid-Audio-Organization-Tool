const ARTIST_TEXT_CONNECTOR_RE = /\s+(?:feat\.?|ft\.?|featuring|with)\s*/gi
const ARTIST_TEXT_SPLITTER_RE = /\s*[,，、&＆/／;；]\s*/g

export const sanitizeArtistName = (value: unknown): string =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')

export const normalizeArtistName = (value: unknown): string => {
  const text = sanitizeArtistName(value)
  return text ? text.toLocaleLowerCase() : ''
}

export const splitArtistNames = (value: unknown): string[] => {
  const text = sanitizeArtistName(value)
  if (!text) return []

  const normalized = text
    .replace(ARTIST_TEXT_CONNECTOR_RE, ',')
    .replace(ARTIST_TEXT_SPLITTER_RE, ',')

  const names: string[] = []
  const seen = new Set<string>()
  for (const part of normalized.split(',')) {
    const name = sanitizeArtistName(part)
    const normalizedName = normalizeArtistName(name)
    if (!normalizedName || seen.has(normalizedName)) continue
    seen.add(normalizedName)
    names.push(name)
  }
  return names
}
