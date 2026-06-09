type ErrorLike = {
  code?: unknown
  message?: unknown
}

export function isENOSPCError(error: unknown): boolean {
  try {
    const err = (error && typeof error === 'object' ? error : null) as ErrorLike | null
    const code = err?.code || ''
    const message = err?.message || ''
    return (
      String(code).toUpperCase() === 'ENOSPC' || /no space left on device/i.test(String(message))
    )
  } catch {
    return false
  }
}
