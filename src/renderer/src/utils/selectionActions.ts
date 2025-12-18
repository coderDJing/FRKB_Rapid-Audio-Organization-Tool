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

const chunk = <T>(items: T[], size: number): T[][] => {
  const safeSize = Number.isFinite(size) && size > 0 ? Math.floor(size) : items.length
  const result: T[][] = []
  for (let i = 0; i < items.length; i += safeSize) {
    result.push(items.slice(i, i + safeSize))
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
  batches: number
  okBatches: number
  failedBatches: number
  firstErrorMessage: string | null
}> {
  const label = params.label
  const totalPaths = Array.isArray(params.filePaths) ? params.filePaths.length : 0
  const filePaths = dedupeFilePaths(Array.isArray(params.filePaths) ? params.filePaths : [])
  const batches = chunk(filePaths, params.batchSize ?? 200)

  const concurrency =
    Number.isFinite(params.concurrency) && (params.concurrency as number) > 0
      ? Math.floor(params.concurrency as number)
      : 2

  let cursor = 0
  const results: Array<{ ok: boolean; errorMessage: string | null }> = new Array(
    batches.length
  ).fill({ ok: true, errorMessage: null })

  const worker = async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= batches.length) return

      const batch = batches[index]
      if (!batch.length) {
        results[index] = { ok: true, errorMessage: null }
        continue
      }

      try {
        const res: any = await window.electron.ipcRenderer.invoke(
          'selection:labels:setForFilePaths',
          {
            filePaths: batch,
            label,
            ...(typeof params.maxAnalyzeSeconds === 'number' && params.maxAnalyzeSeconds > 0
              ? { maxAnalyzeSeconds: params.maxAnalyzeSeconds }
              : {})
          }
        )
        if (!res?.ok) {
          results[index] = {
            ok: false,
            errorMessage: String(res?.failed?.message || res?.failed?.errorCode || 'FAILED')
          }
          continue
        }
        results[index] = { ok: true, errorMessage: null }
      } catch (error: any) {
        results[index] = { ok: false, errorMessage: String(error?.message || error || 'FAILED') }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()))

  let okBatches = 0
  let failedBatches = 0
  let firstErrorMessage: string | null = null
  for (const r of results) {
    if (r.ok) {
      okBatches += 1
    } else {
      failedBatches += 1
      if (!firstErrorMessage) firstErrorMessage = r.errorMessage || 'FAILED'
    }
  }

  return { total: totalPaths, batches: batches.length, okBatches, failedBatches, firstErrorMessage }
}
