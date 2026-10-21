export const normalizePlaylistSearchText = (value: string | number): string =>
  String(value).normalize('NFKC').toLowerCase()

export type PlaylistSearchTextPart = {
  text: string
  matched: boolean
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export const splitPlaylistSearchText = (
  value: string | number,
  query: string
): PlaylistSearchTextPart[] => {
  const text = String(value)
  const keyword = normalizePlaylistSearchText(query.trim())
  const normalizedText = normalizePlaylistSearchText(text)
  if (!keyword || !normalizedText.includes(keyword)) return [{ text, matched: false }]

  // NFKC 和大小写转换可能改变字符长度（如全角、连字）。映射回原文，保留字形与组合字符。
  const sourceRanges: { start: number; end: number }[] = []
  for (const { segment, index } of graphemeSegmenter.segment(text)) {
    const range = { start: index, end: index + segment.length }
    const normalizedLength = normalizePlaylistSearchText(segment).length
    for (let offset = 0; offset < normalizedLength; offset++) sourceRanges.push(range)
  }

  const matches: { start: number; end: number }[] = []
  let from = 0
  while (from < normalizedText.length) {
    const hit = normalizedText.indexOf(keyword, from)
    if (hit < 0) break
    const range = {
      start: sourceRanges[hit].start,
      end: sourceRanges[hit + keyword.length - 1].end
    }
    const previous = matches[matches.length - 1]
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      matches.push(range)
    }
    from = hit + keyword.length
  }

  const parts: PlaylistSearchTextPart[] = []
  let cursor = 0
  for (const range of matches) {
    if (range.start > cursor) {
      parts.push({ text: text.slice(cursor, range.start), matched: false })
    }
    parts.push({ text: text.slice(range.start, range.end), matched: true })
    cursor = range.end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), matched: false })
  return parts
}
