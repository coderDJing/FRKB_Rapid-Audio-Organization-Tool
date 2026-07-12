import { normalizeArtistName, splitArtistNames } from './artistNames'

export const CURATED_ARTIST_LIBRARY_META_KEY = 'curated_artist_library_v1'

type CuratedArtistFavoriteEntry = {
  name: string
  count: number
  fingerprints: string[]
}

const FINGERPRINT_REGEX = /^[a-f0-9]{64}$/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const sanitizeArtistName = (value: unknown): string =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')

const resolveArtistNames = (value: unknown): string[] =>
  Array.from(new Set(splitArtistNames(value).map(sanitizeArtistName).filter(Boolean)))

const sanitizeArtistCount = (value: unknown, fallback = 1): number => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.max(1, Math.round(numeric))
}

const sanitizeFingerprintList = (value: unknown, fallback: string[] = []): string[] => {
  if (!Array.isArray(value)) return [...fallback]
  const seen = new Set<string>()
  const fingerprints: string[] = []
  for (const item of value) {
    const fingerprint = String(item || '')
      .trim()
      .toLowerCase()
    if (!FINGERPRINT_REGEX.test(fingerprint) || seen.has(fingerprint)) continue
    seen.add(fingerprint)
    fingerprints.push(fingerprint)
  }
  fingerprints.sort()
  return fingerprints
}

const normalizeFavoriteEntries = (values: unknown[]): CuratedArtistFavoriteEntry[] => {
  const map = new Map<string, CuratedArtistFavoriteEntry>()
  for (const value of values) {
    const record = isRecord(value) ? value : null
    const rawName =
      typeof value === 'string' ? value : typeof record?.name === 'string' ? record.name : ''
    const rawFingerprints = record?.fingerprints
    const nextCount = sanitizeArtistCount(record?.count)
    for (const name of resolveArtistNames(rawName)) {
      const normalized = normalizeArtistName(name)
      if (!normalized) continue
      const fingerprints = sanitizeFingerprintList(rawFingerprints)
      const count = Math.max(nextCount, fingerprints.length, 1)
      const existing = map.get(normalized)
      if (existing) {
        existing.count += count
        existing.fingerprints = Array.from(
          new Set([...existing.fingerprints, ...fingerprints])
        ).sort()
        existing.count = Math.max(existing.count, existing.fingerprints.length, 1)
      } else {
        map.set(normalized, { name, count, fingerprints })
      }
    }
  }
  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name))
}

const countArtistOccurrences = (values: unknown[]): CuratedArtistFavoriteEntry[] => {
  const map = new Map<string, CuratedArtistFavoriteEntry>()
  for (const value of values) {
    for (const name of resolveArtistNames(value)) {
      const normalized = normalizeArtistName(name)
      if (!normalized) continue
      const existing = map.get(normalized)
      if (existing) existing.count += 1
      else map.set(normalized, { name, count: 1, fingerprints: [] })
    }
  }
  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name))
}

const parseStoredArtists = (raw: string | null | undefined): CuratedArtistFavoriteEntry[] => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return normalizeFavoriteEntries(parsed)
  } catch {}
  return countArtistOccurrences(String(raw).split('\n'))
}

const mergeFavoriteEntries = (
  base: CuratedArtistFavoriteEntry[],
  incoming: CuratedArtistFavoriteEntry[]
): CuratedArtistFavoriteEntry[] => {
  const merged = new Map<string, CuratedArtistFavoriteEntry>()
  for (const entry of normalizeFavoriteEntries(base)) {
    merged.set(normalizeArtistName(entry.name), { ...entry })
  }
  for (const entry of normalizeFavoriteEntries(incoming)) {
    const normalized = normalizeArtistName(entry.name)
    const existing = merged.get(normalized)
    if (existing) {
      existing.count += entry.count
      existing.fingerprints = Array.from(
        new Set([...existing.fingerprints, ...entry.fingerprints])
      ).sort()
      existing.count = Math.max(
        existing.count,
        existing.fingerprints.length,
        entry.fingerprints.length
      )
    } else {
      merged.set(normalized, { ...entry })
    }
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export const mergeStoredCuratedArtistLibrary = (
  targetRaw: string | null | undefined,
  sourceRaw: string | null | undefined
): string =>
  JSON.stringify(mergeFavoriteEntries(parseStoredArtists(targetRaw), parseStoredArtists(sourceRaw)))
