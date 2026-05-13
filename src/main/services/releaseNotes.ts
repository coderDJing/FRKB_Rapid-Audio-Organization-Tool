import { log } from '../log'
import { fetchWithSystemProxy } from '../fetchWithSystemProxy'
import {
  compareReleaseVersions,
  isReleaseInNotesChannel,
  normalizeReleaseVersion,
  resolveReleaseNotesChannel,
  type ReleaseNotesEntry,
  type ReleaseNotesRangePayload
} from '../../shared/releaseNotes'

const RELEASES_URL =
  'https://api.github.com/repos/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases'
const MAX_RELEASE_PAGES = 3
const RELEASES_PER_PAGE = 100

type GitHubReleaseRecord = {
  name?: unknown
  tag_name?: unknown
  body?: unknown
  published_at?: unknown
  html_url?: unknown
  prerelease?: unknown
  draft?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const toSafeString = (value: unknown): string => (typeof value === 'string' ? value : '')

const normalizeGitHubRelease = (release: GitHubReleaseRecord): ReleaseNotesEntry | null => {
  const tagName = toSafeString(release.tag_name)
  const version = normalizeReleaseVersion(tagName)
  if (!version) return null
  return {
    title: toSafeString(release.name || tagName),
    tagName,
    version,
    body: toSafeString(release.body),
    publishedAt: toSafeString(release.published_at),
    htmlUrl: toSafeString(release.html_url)
  }
}

async function fetchReleasePage(
  page: number,
  currentVersion: string
): Promise<GitHubReleaseRecord[]> {
  const url = `${RELEASES_URL}?per_page=${RELEASES_PER_PAGE}&page=${page}`
  const res = await fetchWithSystemProxy(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `FRKB/${currentVersion}`
    }
  })
  if (!res.ok) {
    log.error('[releaseNotes] 拉取 GitHub releases 失败', { status: res.status, page })
    return []
  }
  const data = await res.json()
  if (!Array.isArray(data)) return []
  return data.filter(isRecord)
}

export async function fetchReleaseNotesRange(
  currentVersion: string,
  latestVersion: string
): Promise<ReleaseNotesRangePayload | null> {
  const normalizedCurrent = normalizeReleaseVersion(currentVersion)
  const normalizedLatest = normalizeReleaseVersion(latestVersion)
  const channel = resolveReleaseNotesChannel(normalizedCurrent)

  if (!normalizedCurrent || !normalizedLatest) {
    return {
      currentVersion: normalizedCurrent,
      latestVersion: normalizedLatest,
      channel,
      releases: []
    }
  }

  try {
    const releases: ReleaseNotesEntry[] = []

    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      const records = await fetchReleasePage(page, normalizedCurrent)
      if (!records.length) break

      for (const record of records) {
        if (record.draft === true) continue
        const entry = normalizeGitHubRelease(record)
        if (!entry) continue
        if (!isReleaseInNotesChannel(entry.version, record.prerelease === true, channel)) continue
        if (compareReleaseVersions(entry.version, normalizedCurrent) <= 0) continue
        if (compareReleaseVersions(entry.version, normalizedLatest) > 0) continue
        releases.push(entry)
      }

      if (records.length < RELEASES_PER_PAGE) break
    }

    releases.sort((left, right) => compareReleaseVersions(right.version, left.version))

    return {
      currentVersion: normalizedCurrent,
      latestVersion: normalizedLatest,
      channel,
      releases
    }
  } catch (error) {
    log.error('[releaseNotes] 拉取版本区间更新日志异常', error)
    return null
  }
}
