import type { IMetadataAutoFillSummary } from 'src/types/globals'

export async function invokeMetadataAutoFill(
  filePaths: string[],
  progressId?: string
): Promise<IMetadataAutoFillSummary | null> {
  const uniquePaths = Array.from(
    new Set(
      (filePaths || [])
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => p.trim())
    )
  )
  if (!uniquePaths.length) {
    return null
  }
  const payload = {
    filePaths: uniquePaths,
    progressId: progressId || `metadata_auto_${Date.now()}`
  }
  const summary = (await window.electron.ipcRenderer.invoke(
    'metadata:autoFill',
    payload
  )) as IMetadataAutoFillSummary
  return summary
}
