import { app, dialog, ipcMain } from 'electron'
import path from 'node:path'
import store from '../store'
import mainWindow from '../window/mainWindow'
import { getLibrary } from '../utils'
import { markGlobalSongSearchDirty } from '../services/globalSongSearch'
import {
  LibraryMergeError,
  inspectLibraryMergeSource,
  isLibraryMergeActive,
  mergeFrkbLibraries,
  type LibraryMergeMode
} from '../services/libraryMerge'
import { acquireLibraryMergeMutationLock } from '../services/libraryMerge/runtime'

type LibraryMergeStartPayload = {
  sourceRoot?: unknown
  mode?: unknown
}

const normalizeMode = (value: unknown): LibraryMergeMode =>
  value === 'delete-source' ? 'delete-source' : 'copy'

const getTargetRoot = (): string =>
  String(store.databaseDir || store.settingConfig?.databaseUrl || '').trim()

const getErrorPayload = (error: unknown) => {
  if (error instanceof LibraryMergeError) {
    return { success: false as const, code: error.code, message: error.message }
  }
  return {
    success: false as const,
    code: 'LIBRARY_MERGE_FAILED',
    message: error instanceof Error ? error.message : String(error || 'unknown error')
  }
}

const runMerge = async (sourceRoot: string, mode: LibraryMergeMode) => {
  const targetRoot = getTargetRoot()
  if (!targetRoot) throw new LibraryMergeError('TARGET_NOT_READY', '当前 FRKB 库尚未打开')
  const releaseMutationLock = acquireLibraryMergeMutationLock(mainWindow.instance)
  try {
    const result = await mergeFrkbLibraries({
      sourceRoot,
      targetRoot,
      appVersion: app.getVersion(),
      mode,
      onProgress: (progress) => {
        try {
          mainWindow.instance?.webContents.send('library-merge:progress', progress)
        } catch {}
      }
    })
    markGlobalSongSearchDirty('library-merge')
    const libraryTree = await getLibrary({ skipSync: true })
    mainWindow.instance?.webContents.send('library-tree-updated', libraryTree)
    return result
  } finally {
    releaseMutationLock()
  }
}

const selectSourceRoot = async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'FRKB 数据库', extensions: ['frkbdb'] }]
  })
  if (result.canceled || !result.filePaths[0]) return null
  const manifestPath = result.filePaths[0]
  if (path.basename(manifestPath) !== 'FRKB.database.frkbdb') {
    throw new LibraryMergeError('SOURCE_MANIFEST_INVALID', '请选择 FRKB.database.frkbdb')
  }
  return path.dirname(manifestPath)
}

export async function runLibraryMergeFromMenu(): Promise<void> {
  if (isLibraryMergeActive()) return
  try {
    const targetRoot = getTargetRoot()
    if (!targetRoot) throw new LibraryMergeError('TARGET_NOT_READY', '当前 FRKB 库尚未打开')
    const introduction = await dialog.showMessageBox({
      type: 'question',
      title: '合并 FRKB 库',
      message: '将另一个 FRKB 库合并到当前正在使用的库',
      detail:
        '当前库会作为合并目标。下一步请选择来源库内的“FRKB.database.frkbdb”文件。\n\n' +
        'FRKB 会先检查来源库的完整性、目录结构和磁盘空间；检查通过后才会开始合并。合并期间当前库会被锁定，无法进行其他更改。\n\n' +
        '会合并歌单、曲目、分析数据及相关资源（不包含回收站）。同名歌单会自动添加来源库后缀。稍后您可选择保留来源库，或只在合并成功后删除它。',
      buttons: ['选择来源库', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (introduction.response === 1) return
    const sourceRoot = await selectSourceRoot()
    if (!sourceRoot) return
    await inspectLibraryMergeSource({ sourceRoot, targetRoot, appVersion: app.getVersion() })
    const choice = await dialog.showMessageBox({
      type: 'question',
      title: '合并 FRKB 库',
      message: '请选择来源库的处理方式',
      detail: '合并完成前来源库不会被修改。删除来源库仅在当前库成功保存后执行。',
      buttons: ['复制并合并', '合并后删除来源库', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })
    if (choice.response === 2) return
    const result = await runMerge(sourceRoot, choice.response === 1 ? 'delete-source' : 'copy')
    await dialog.showMessageBox({
      type: result.sourceDeleteError ? 'warning' : 'info',
      title: result.sourceDeleteError ? '合并已完成，来源清理未完成' : 'FRKB 库合并完成',
      message: `已导入 ${result.songListCount} 个歌单和 ${result.copiedFileCount} 个文件。`,
      detail: result.sourceDeleteError || undefined
    })
  } catch (error) {
    const failure = getErrorPayload(error)
    await dialog.showMessageBox({
      type: 'error',
      title: '无法合并 FRKB 库',
      message: failure.message
    })
  }
}

export function registerLibraryMergeHandlers(): void {
  ipcMain.handle('library-merge:select-source', async () => {
    try {
      const sourceRoot = await selectSourceRoot()
      return { success: true as const, sourceRoot }
    } catch (error) {
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-merge:inspect', async (_event, sourceRoot: unknown) => {
    try {
      const targetRoot = getTargetRoot()
      if (!targetRoot) throw new LibraryMergeError('TARGET_NOT_READY', '当前 FRKB 库尚未打开')
      const summary = await inspectLibraryMergeSource({
        sourceRoot: String(sourceRoot || ''),
        targetRoot,
        appVersion: app.getVersion()
      })
      return { success: true as const, summary }
    } catch (error) {
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-merge:start', async (_event, payload?: LibraryMergeStartPayload) => {
    try {
      const sourceRoot = String(payload?.sourceRoot || '').trim()
      if (!sourceRoot) throw new LibraryMergeError('SOURCE_MANIFEST_INVALID', '未选择来源库')
      const result = await runMerge(sourceRoot, normalizeMode(payload?.mode))
      return { success: true as const, result }
    } catch (error) {
      return getErrorPayload(error)
    }
  })

  ipcMain.handle('library-merge:active', () => isLibraryMergeActive())
  ipcMain.handle('library-merge:run-from-menu', async () => {
    await runLibraryMergeFromMenu()
    return { success: true as const }
  })
}
