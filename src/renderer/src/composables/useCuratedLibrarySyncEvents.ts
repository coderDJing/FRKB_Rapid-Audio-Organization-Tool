import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { continueCuratedLibrarySyncUi } from '@renderer/composables/runCuratedLibrarySyncUi'
import type {
  CuratedLibrarySyncNotice,
  CuratedLibrarySyncStartResult
} from '../../../shared/curatedLibrarySync'

const isCuratedLibrarySyncNotice = (value: unknown): value is CuratedLibrarySyncNotice => {
  if (!value || typeof value !== 'object') return false
  if (!('kind' in value) || !('conflictCount' in value) || !('failureCount' in value)) return false
  return (
    (value.kind === 'conflicts' || value.kind === 'failures') &&
    typeof value.conflictCount === 'number' &&
    typeof value.failureCount === 'number'
  )
}

const isJoinPromptResult = (
  value: unknown
): value is Extract<
  CuratedLibrarySyncStartResult,
  { status: 'needs_join_choice' | 'needs_overwrite_cloud_confirm' }
> => {
  if (!value || typeof value !== 'object' || !('status' in value)) return false
  const status = (value as { status?: unknown }).status
  return status === 'needs_join_choice' || status === 'needs_overwrite_cloud_confirm'
}

export function useCuratedLibrarySyncEvents() {
  let noticeOpen = false
  let joinPromptOpen = false

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

  const handleCuratedLibraryJoinPrompt = async (payload: unknown) => {
    if (joinPromptOpen || !isJoinPromptResult(payload)) return
    joinPromptOpen = true
    try {
      await window.electron.ipcRenderer.invoke('curatedLibrarySync/clearPendingJoin')
      await continueCuratedLibrarySyncUi(payload, { quietTerminal: true })
    } finally {
      joinPromptOpen = false
    }
  }

  const handleCuratedLibrarySyncNeedsJoin = (_e: unknown, payload: unknown) => {
    void handleCuratedLibraryJoinPrompt(payload)
  }

  const consumePendingCuratedLibraryJoin = async () => {
    try {
      const pending = await window.electron.ipcRenderer.invoke('curatedLibrarySync/getPendingJoin')
      await handleCuratedLibraryJoinPrompt(pending)
    } catch {}
  }

  return {
    handleCuratedLibrarySyncNotice,
    handleCuratedLibrarySyncNeedsJoin,
    consumePendingCuratedLibraryJoin
  }
}
