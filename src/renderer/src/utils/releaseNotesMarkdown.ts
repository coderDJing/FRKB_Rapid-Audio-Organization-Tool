import { marked } from 'marked'
import type { ReleaseNotesRangePayload } from '@shared/releaseNotes'

const formatReleaseDate = (publishedAt: string): string => {
  if (!publishedAt) return ''
  try {
    const dt = new Date(publishedAt)
    if (Number.isNaN(dt.getTime())) return publishedAt
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(
      dt.getDate()
    ).padStart(2, '0')}`
  } catch {
    return publishedAt
  }
}

export const buildReleaseNotesMarkdown = (
  payload: ReleaseNotesRangePayload,
  noChangelogText: string
): string =>
  payload.releases
    .map((release) => {
      const title = release.title?.trim() || release.tagName || release.version
      const published = formatReleaseDate(release.publishedAt)
      const body = release.body?.trim() || noChangelogText
      return [`## ${title}`, published ? `_${published}_` : '', body].filter(Boolean).join('\n\n')
    })
    .join('\n\n---\n\n')

export const renderMarkdownToHtml = async (markdown: string): Promise<string> => {
  if (!markdown) return ''
  const parsed = marked.parse(markdown)
  return typeof parsed === 'string' ? parsed : await parsed
}
