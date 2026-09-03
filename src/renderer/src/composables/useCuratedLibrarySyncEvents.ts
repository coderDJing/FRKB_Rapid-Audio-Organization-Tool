import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import type { CuratedLibrarySyncNotice } from '../../../shared/curatedLibrarySync'

const isCuratedLibrarySyncNotice = (value: unknown): value is CuratedLibrarySyncNotice => {
  if (!value || typeof value !== 'object') return false
  if (!('kind' in value) || !('conflictCount' in value) || !('failureCount' in value)) return false
  return (
    (value.kind === 'conflicts' || value.kind === 'failures') &&
    typeof value.conflictCount === 'number' &&
    typeof value.failureCount === 'number'
  )
}

export function useCuratedLibrarySyncEvents() {
  let noticeOpen = false

  const handleCuratedLibrarySyncNotice = async (_e: unknown, payload: unknown) => {
    if (noticeOpen || !isCuratedLibrarySyncNotice(payload)) return
    noticeOpen = true
    try {
      const lines: string[] = []
      if (payload.conflictCount > 0) {
        lines.push(t('cloudSync.curatedLibrary.noticeConflicts', { count: payload.conflictCount }))
      }
      if (payload.failureCount > 0) {
        lines.push(t('cloudSync.curatedLibrary.noticeFailures', { count: payload.failureCount }))
      }
      if (lines.length === 0) return
      lines.push(t('cloudSync.curatedLibrary.openSettingsHint'))
      await confirm({
        title:
          payload.kind === 'conflicts'
            ? t('cloudSync.curatedLibrary.noticeConflictsTitle')
            : t('cloudSync.curatedLibrary.noticeFailuresTitle'),
        content: lines,
        confirmShow: false
      })
    } finally {
      noticeOpen = false
    }
  }

  return { handleCuratedLibrarySyncNotice }
}
