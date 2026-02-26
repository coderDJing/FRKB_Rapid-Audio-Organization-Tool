export const isMissingFileDecodeError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error || '')
  if (!message) return false
  const lower = message.toLowerCase()
  return (
    lower.includes('enoent') ||
    lower.includes('no such file') ||
    lower.includes('error opening input') ||
    message.includes('打开文件失败')
  )
}
