const VERSION_SUFFIX = /^(.*) \((\d+)\)$/

export const sanitizeSongEditFileName = (value: string) =>
  String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export const parseSongEditBaseTitle = (title: string) => {
  const raw = String(title || '').trim()
  const matched = VERSION_SUFFIX.exec(raw)
  return matched?.[1]?.trim() || raw
}

export const stripSongEditLabelExt = (value: string) =>
  String(value || '')
    .replace(/\.[^.]+$/, '')
    .trim()

const collectMaxVersionNumber = (baseTitle: string, labels: readonly string[]) => {
  const escaped = baseTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matcher = new RegExp(`^${escaped} \\((\\d+)\\)$`)
  let maxUsed = 1
  for (const label of labels) {
    const matched = matcher.exec(String(label || '').trim())
    if (!matched) continue
    const value = Number(matched[1])
    if (Number.isFinite(value)) maxUsed = Math.max(maxUsed, value)
  }
  return maxUsed
}

export const buildSongEditVersionFileName = (
  baseTitle: string,
  versionNumber: number,
  ext: string
) => {
  const safeTitle =
    sanitizeSongEditFileName(`${baseTitle} (${versionNumber})`) || `Track (${versionNumber})`
  const safeExt = String(ext || 'wav')
    .replace(/^\./, '')
    .toLowerCase()
  return `${safeTitle}.${safeExt}`
}

export const resolveUniqueSongEditVersion = (params: {
  baseTitle: string
  outputExt: string
  existingNames?: readonly string[]
  diskFileNames?: readonly string[]
}) => {
  const baseTitle = parseSongEditBaseTitle(params.baseTitle) || 'Track'
  const outputExt = String(params.outputExt || 'wav')
    .replace(/^\./, '')
    .toLowerCase()
  const labels = [
    ...(params.existingNames || []).map((name) => stripSongEditLabelExt(name)),
    ...(params.diskFileNames || [])
      .filter((name) => {
        const ext = String(name || '')
          .split('.')
          .pop()
          ?.toLowerCase()
        return ext === outputExt
      })
      .map((name) => stripSongEditLabelExt(name))
  ]
  const diskNames = new Set(
    (params.diskFileNames || [])
      .map((name) =>
        String(name || '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  )
  let versionNumber = collectMaxVersionNumber(baseTitle, labels) + 1
  let destFileName = buildSongEditVersionFileName(baseTitle, versionNumber, outputExt)
  while (diskNames.has(destFileName.toLowerCase())) {
    versionNumber += 1
    destFileName = buildSongEditVersionFileName(baseTitle, versionNumber, outputExt)
  }
  return {
    baseTitle,
    versionNumber,
    versionTitle: `${baseTitle} (${versionNumber})`,
    destFileName
  }
}
