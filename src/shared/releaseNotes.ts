export type ReleaseNotesChannel = 'stable' | 'rc'

export type ReleaseNotesEntry = {
  title: string
  tagName: string
  version: string
  body: string
  publishedAt: string
  htmlUrl: string
}

export type ReleaseNotesRangePayload = {
  currentVersion: string
  latestVersion: string
  channel: ReleaseNotesChannel
  releases: ReleaseNotesEntry[]
}

type ParsedReleaseVersion = {
  major: number
  minor: number
  patch: number
  prerelease: string | null
}

const RELEASE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export const normalizeReleaseVersion = (version: string): string =>
  String(version || '')
    .trim()
    .replace(/^v(?=\d)/i, '')

export const resolveReleaseNotesChannel = (version: string): ReleaseNotesChannel =>
  normalizeReleaseVersion(version).includes('-') ? 'rc' : 'stable'

const isRcReleaseVersion = (version: string): boolean =>
  /-rc(?:[.-]|$)/i.test(normalizeReleaseVersion(version))

const parseReleaseVersion = (version: string): ParsedReleaseVersion | null => {
  const normalized = normalizeReleaseVersion(version)
  const match = RELEASE_VERSION_PATTERN.exec(normalized)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null
  }
}

const compareNumbers = (left: number, right: number): number => {
  if (left === right) return 0
  return left > right ? 1 : -1
}

const comparePrereleaseIdentifier = (left: string, right: string): number => {
  if (left === right) return 0
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) {
    return compareNumbers(Number(left), Number(right))
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left > right ? 1 : -1
}

const comparePrerelease = (left: string | null, right: string | null): number => {
  if (!left && !right) return 0
  if (!left) return 1
  if (!right) return -1
  const leftParts = left.split('.')
  const rightParts = right.split('.')
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index]
    const rightPart = rightParts[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const result = comparePrereleaseIdentifier(leftPart, rightPart)
    if (result !== 0) return result
  }
  return 0
}

export const compareReleaseVersions = (left: string, right: string): number => {
  const leftParsed = parseReleaseVersion(left)
  const rightParsed = parseReleaseVersion(right)
  if (!leftParsed || !rightParsed) {
    const normalizedLeft = normalizeReleaseVersion(left)
    const normalizedRight = normalizeReleaseVersion(right)
    if (normalizedLeft === normalizedRight) return 0
    return normalizedLeft > normalizedRight ? 1 : -1
  }

  const major = compareNumbers(leftParsed.major, rightParsed.major)
  if (major !== 0) return major
  const minor = compareNumbers(leftParsed.minor, rightParsed.minor)
  if (minor !== 0) return minor
  const patch = compareNumbers(leftParsed.patch, rightParsed.patch)
  if (patch !== 0) return patch
  return comparePrerelease(leftParsed.prerelease, rightParsed.prerelease)
}

export const isReleaseInNotesChannel = (
  version: string,
  prerelease: boolean,
  channel: ReleaseNotesChannel
): boolean => {
  const normalized = normalizeReleaseVersion(version)
  if (channel === 'rc') return prerelease && isRcReleaseVersion(normalized)
  return !prerelease && !normalized.includes('-')
}
