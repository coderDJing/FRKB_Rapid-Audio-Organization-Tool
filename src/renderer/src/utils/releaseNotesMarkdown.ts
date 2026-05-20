import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { ReleaseNotesRangePayload } from '@shared/releaseNotes'

const RELEASE_NOTES_ALLOWED_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul'
]

const RELEASE_NOTES_ALLOWED_ATTR = [
  'align',
  'alt',
  'class',
  'colspan',
  'height',
  'href',
  'rel',
  'rowspan',
  'src',
  'target',
  'title',
  'width'
]

let sanitizerHookInstalled = false

const ensureSanitizerHooks = () => {
  if (sanitizerHookInstalled) return
  sanitizerHookInstalled = true
  DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
    const element = node as Element
    if (element.tagName?.toLowerCase() !== 'a') return
    if (!element.getAttribute('href')) return
    element.setAttribute('target', '_blank')
    element.setAttribute('rel', 'noopener noreferrer')
  })
}

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
  const html = typeof parsed === 'string' ? parsed : await parsed
  ensureSanitizerHooks()
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: RELEASE_NOTES_ALLOWED_TAGS,
    ALLOWED_ATTR: RELEASE_NOTES_ALLOWED_ATTR,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[#/]|\.{0,2}\/)/i
  })
}
