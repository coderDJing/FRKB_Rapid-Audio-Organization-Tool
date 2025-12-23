type SelectionLabel = 'liked' | 'disliked' | 'neutral'

const normalizePath = (p: string) => (p || '').trim().replace(/\//g, '\\').toLowerCase()

const dedupeFilePaths = (filePaths: string[]): string[] => {
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of filePaths) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = normalizePath(trimmed)
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

export async function setSelectionLabelForFilePathsBatched(params: {
  filePaths: string[]
  label: SelectionLabel
  batchSize?: number
  concurrency?: number
  maxAnalyzeSeconds?: number
}): Promise<{
  total: number
  totalUnique: number
  batches: number
  okBatches: number
  failedBatches: number
  cancelledBatches: number
  firstErrorMessage: string | null
  cancelled: boolean
}> {
  const label = params.label
  const totalPaths = Array.isArray(params.filePaths) ? params.filePaths.length : 0
  const filePaths = dedupeFilePaths(Array.isArray(params.filePaths) ? params.filePaths : [])
  const batchSize =
    Number.isFinite(params.batchSize) && params.batchSize > 0 ? Math.floor(params.batchSize) : 200
  const concurrency =
    Number.isFinite(params.concurrency) && params.concurrency > 0
      ? Math.floor(params.concurrency)
      : 2

  try {
    const res: any = await window.electron.ipcRenderer.invoke(
      'selection:labels:setForFilePathsBatched',
      {
        filePaths,
        label,
        batchSize,
        concurrency,
        ...(typeof params.maxAnalyzeSeconds === 'number' && params.maxAnalyzeSeconds > 0
          ? { maxAnalyzeSeconds: params.maxAnalyzeSeconds }
          : {})
      }
    )
    if (!res?.ok) {
      const message = String(res?.failed?.message || res?.failed?.errorCode || 'FAILED')
      const totalUnique =
        typeof res?.totalUnique === 'number' && Number.isFinite(res.totalUnique)
          ? res.totalUnique
          : filePaths.length
      return {
        total: totalPaths,
        totalUnique,
        batches: Number(res?.batches || 0),
        okBatches: Number(res?.okBatches || 0),
        failedBatches: Number(res?.failedBatches || 1),
        cancelledBatches: Number(res?.cancelledBatches || 0),
        firstErrorMessage: message,
        cancelled: Boolean(res?.cancelled)
      }
    }
    const totalUnique =
      typeof res?.totalUnique === 'number' && Number.isFinite(res.totalUnique)
        ? res.totalUnique
        : filePaths.length
    return {
      total: totalPaths,
      totalUnique,
      batches: Number(res?.batches || 0),
      okBatches: Number(res?.okBatches || 0),
      failedBatches: Number(res?.failedBatches || 0),
      cancelledBatches: Number(res?.cancelledBatches || 0),
      firstErrorMessage: res?.firstErrorMessage ? String(res.firstErrorMessage) : null,
      cancelled: Boolean(res?.cancelled)
    }
  } catch (error: any) {
    return {
      total: totalPaths,
      totalUnique: filePaths.length,
      batches: 0,
      okBatches: 0,
      failedBatches: 1,
      cancelledBatches: 0,
      firstErrorMessage: String(error?.message || error || 'FAILED'),
      cancelled: false
    }
  }
}
