import mainWindow from '../window/mainWindow'
import type { CuratedLibrarySyncStartResult } from '../../shared/curatedLibrarySync'

type CuratedLibraryJoinPromptResult = Extract<
  CuratedLibrarySyncStartResult,
  { status: 'needs_join_choice' | 'needs_overwrite_cloud_confirm' }
>

let pendingJoinPrompt: CuratedLibraryJoinPromptResult | null = null

const isJoinPromptResult = (
  result: CuratedLibrarySyncStartResult
): result is CuratedLibraryJoinPromptResult =>
  result.status === 'needs_join_choice' || result.status === 'needs_overwrite_cloud_confirm'

export const getPendingCuratedLibraryJoinPrompt = (): CuratedLibraryJoinPromptResult | null =>
  pendingJoinPrompt

export const clearPendingCuratedLibraryJoinPrompt = (): void => {
  pendingJoinPrompt = null
}

/** 定时/启动同步遇到第一次对齐时通知渲染层；主窗口还没挂上监听时先留着。 */
export const offerCuratedLibraryJoinPrompt = (result: CuratedLibrarySyncStartResult): void => {
  if (!isJoinPromptResult(result)) return
  pendingJoinPrompt = result
  const win = mainWindow.instance
  if (!win || win.isDestroyed()) return
  win.webContents.send('curatedLibrarySync/needsJoin', result)
}
