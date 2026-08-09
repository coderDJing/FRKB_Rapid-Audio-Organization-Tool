export const resolveCoverPathIdentity = (
  value: string | undefined | null,
  platform: string | undefined
): string => {
  const filePath = String(value || '').trim()
  if (platform === 'win32') return filePath.replace(/\//g, '\\').toLowerCase()
  return filePath
}
