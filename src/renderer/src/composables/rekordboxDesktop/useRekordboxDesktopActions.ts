import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'
import confirm from '@renderer/components/confirmDialog'
import openRekordboxDesktopCreateNodeDialog from '@renderer/components/rekordboxDesktopCreateNodeDialog'
import rightClickMenu from '@renderer/components/rightClickMenu'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { ensureRekordboxDesktopWriteAvailable } from '@renderer/utils/rekordboxDesktopWriteAvailability'
import { clearRekordboxSourceCachesByKind } from '@renderer/utils/rekordboxLibraryCache'
import { t } from '@renderer/utils/translate'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type {
  RekordboxDesktopCreateEmptyPlaylistResponse,
  RekordboxDesktopCreateFolderResponse,
  RekordboxDesktopDeletePlaylistResponse,
  RekordboxDesktopRenamePlaylistResponse
} from '@shared/rekordboxDesktopPlaylist'
import { countNodeDescendants, sanitizeNodeName } from './useRekordboxTreeUtils'

type LoadTreeFn = (preferredPlaylistId?: number) => Promise<void>
type RunWritingFn = <T>(task: () => Promise<T>) => Promise<T>

export function useRekordboxDesktopActions(
  dialogWriting: { value: boolean },
  playlistSearch: { value: string },
  selectedArea: { value: 'recent' | 'tree' | '' },
  expandedFolderIds: { value: Set<number> },
  loadTree: LoadTreeFn,
  runWithDialogWriting: RunWritingFn
) {
  const runtime = useRuntimeStore()
  const renameMenuKey = 'common.rename'
  const deleteFolderMenuKey = 'rekordboxDesktop.deleteFolderAction'
  const deletePlaylistMenuKey = 'playlist.deletePlaylist'

  const showFailureDialog = async (message: string, logPath?: string) => {
    const content = [t('rekordboxDesktop.failedReason', { message })]
    if (logPath) {
      content.push(t('rekordboxDesktop.failureLogHint', { path: logPath }))
    }
    await confirm({
      title: t('rekordboxDesktop.failureTitle'),
      content,
      confirmShow: false,
      innerWidth: 620,
      innerHeight: 0,
      textAlign: 'left',
      canCopyText: Boolean(logPath)
    })
  }

  const createEmptyPlaylist = async (playlistName: string, parentId = 0) => {
    if (dialogWriting.value) return false
    return await runWithDialogWriting(async () => {
      if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return false
      const response = (await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('desktop', 'create-empty-playlist'),
        {
          playlistName,
          parentId
        }
      )) as RekordboxDesktopCreateEmptyPlaylistResponse

      if (!response.ok) {
        await showFailureDialog(response.summary.errorMessage, response.summary.logPath)
        return false
      }

      clearRekordboxSourceCachesByKind('desktop')
      playlistSearch.value = ''
      selectedArea.value = 'tree'
      await loadTree(response.summary.playlistId)
      return true
    })
  }

  const createFolder = async (folderName: string, parentId = 0) => {
    if (dialogWriting.value) return false
    return await runWithDialogWriting(async () => {
      if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return false
      const response = (await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('desktop', 'create-folder'),
        {
          folderName,
          parentId
        }
      )) as RekordboxDesktopCreateFolderResponse

      if (!response.ok) {
        await showFailureDialog(response.summary.errorMessage, response.summary.logPath)
        return false
      }

      clearRekordboxSourceCachesByKind('desktop')
      playlistSearch.value = ''
      await loadTree(Number(runtime.dialogSelectedSongListUUID) || 0)
      const nextExpanded = new Set(expandedFolderIds.value)
      if (parentId > 0) nextExpanded.add(parentId)
      nextExpanded.add(response.summary.folderId)
      expandedFolderIds.value = nextExpanded
      return true
    })
  }

  const renameNode = async (node: IPioneerPlaylistTreeNode, nextName: string) => {
    if (dialogWriting.value) return false
    const playlistId = Number(node.id) || 0
    const name = sanitizeNodeName(nextName)
    if (playlistId <= 0 || !name) return false
    if (name === sanitizeNodeName(node.name)) return true

    return await runWithDialogWriting(async () => {
      if (!(await ensureRekordboxDesktopWriteAvailable('create'))) return false
      const response = (await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('desktop', 'rename-playlist'),
        {
          playlistId,
          name
        }
      )) as RekordboxDesktopRenamePlaylistResponse

      if (!response.ok) {
        await showFailureDialog(response.summary.errorMessage, response.summary.logPath)
        return false
      }

      clearRekordboxSourceCachesByKind('desktop')
      await loadTree(Number(runtime.dialogSelectedSongListUUID) || playlistId)
      return true
    })
  }

  const deleteNode = async (node: IPioneerPlaylistTreeNode) => {
    if (dialogWriting.value) return false
    const playlistId = Number(node.id) || 0
    if (playlistId <= 0) return false

    return await runWithDialogWriting(async () => {
      if (!(await ensureRekordboxDesktopWriteAvailable('create'))) return false
      const response = (await window.electron.ipcRenderer.invoke(
        buildRekordboxSourceChannel('desktop', 'delete-playlist'),
        {
          playlistId
        }
      )) as RekordboxDesktopDeletePlaylistResponse

      if (!response.ok) {
        await showFailureDialog(response.summary.errorMessage, response.summary.logPath)
        return false
      }

      clearRekordboxSourceCachesByKind('desktop')
      await loadTree(Number(runtime.dialogSelectedSongListUUID) || response.summary.parentId || 0)
      return true
    })
  }

  const openCreatePlaylistDialog = async (parentId = 0, defaultValue = '') => {
    await openRekordboxDesktopCreateNodeDialog({
      dialogTitle: t('rekordboxDesktop.createPlaylistDialogTitle'),
      placeholder: t('rekordboxDesktop.playlistNamePlaceholder'),
      defaultValue,
      confirmText: t('common.confirm'),
      confirmCallback: async (value) => {
        if (!value) return false
        return await createEmptyPlaylist(value, parentId)
      }
    })
  }

  const openCreateFolderDialog = async (parentId = 0) => {
    await openRekordboxDesktopCreateNodeDialog({
      dialogTitle: t('rekordboxDesktop.createFolderTitle'),
      placeholder: t('rekordboxDesktop.folderNamePlaceholder'),
      confirmText: t('common.confirm'),
      confirmCallback: async (value) => {
        if (!value) return false
        return await createFolder(value, parentId)
      }
    })
  }

  const openRenameNodeDialog = async (node: IPioneerPlaylistTreeNode) => {
    if (dialogWriting.value || node.isSmartPlaylist) return
    await openRekordboxDesktopCreateNodeDialog({
      dialogTitle: node.isFolder
        ? t('rekordboxDesktop.renameFolderTitle')
        : t('rekordboxDesktop.renamePlaylistTitle'),
      placeholder: node.isFolder
        ? t('rekordboxDesktop.folderNamePlaceholder')
        : t('rekordboxDesktop.playlistNamePlaceholder'),
      defaultValue: String(node.name || '').trim(),
      confirmText: t('common.confirm'),
      confirmCallback: async (value) => {
        if (!value) return false
        return await renameNode(node, value)
      }
    })
  }

  const confirmDeleteNode = async (node: IPioneerPlaylistTreeNode) => {
    if (dialogWriting.value || node.isSmartPlaylist) return

    const lines = node.isFolder
      ? (() => {
          const descendants = countNodeDescendants(node)
          const content = [
            t('rekordboxDesktop.deleteFolderConfirmLine1', { name: node.name }),
            t('rekordboxDesktop.deleteFolderConfirmLine2')
          ]
          if (descendants.folderCount > 0 || descendants.playlistCount > 0) {
            content.push(
              t('rekordboxDesktop.deleteFolderDescendants', {
                folderCount: descendants.folderCount,
                playlistCount: descendants.playlistCount
              })
            )
          }
          return content
        })()
      : [
          t('rekordboxDesktop.deletePlaylistConfirmLine1', { name: node.name }),
          t('rekordboxDesktop.deletePlaylistConfirmLine2')
        ]

    const result = await confirm({
      title: node.isFolder
        ? t('rekordboxDesktop.deleteFolderTitle')
        : t('rekordboxDesktop.deletePlaylistTitle'),
      content: lines,
      innerWidth: 620,
      innerHeight: 0,
      textAlign: 'left'
    })
    if (result !== 'confirm') return
    await deleteNode(node)
  }

  const contextmenuEvent = async (event: MouseEvent, parentId = 0, defaultPlaylistName = '') => {
    if (dialogWriting.value) return
    const menuArr = [[{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]]
    const result = await rightClickMenu({ menuArr, clickEvent: event })
    if (result === 'cancel') return
    if (result.menuName === 'library.createPlaylist') {
      await openCreatePlaylistDialog(
        parentId,
        parentId <= 0 ? String(playlistSearch.value || '').trim() || defaultPlaylistName : ''
      )
      return
    }
    if (result.menuName === 'library.createFolder') {
      await openCreateFolderDialog(parentId)
    }
  }

  const handleNodeContextmenu = async (event: MouseEvent, node: IPioneerPlaylistTreeNode) => {
    if (dialogWriting.value || node.isSmartPlaylist) return

    if (node.isFolder) {
      const menuArr = [
        [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }],
        [{ menuName: renameMenuKey }, { menuName: deleteFolderMenuKey }]
      ]
      const result = await rightClickMenu({ menuArr, clickEvent: event })
      if (result === 'cancel') return
      if (result.menuName === 'library.createPlaylist') {
        await openCreatePlaylistDialog(Number(node.id) || 0)
        return
      }
      if (result.menuName === 'library.createFolder') {
        await openCreateFolderDialog(Number(node.id) || 0)
        return
      }
      if (result.menuName === renameMenuKey) {
        await openRenameNodeDialog(node)
        return
      }
      if (result.menuName === deleteFolderMenuKey) {
        await confirmDeleteNode(node)
      }
      return
    }

    const menuArr = [[{ menuName: renameMenuKey }, { menuName: deletePlaylistMenuKey }]]
    const result = await rightClickMenu({ menuArr, clickEvent: event })
    if (result === 'cancel') return
    if (result.menuName === renameMenuKey) {
      await openRenameNodeDialog(node)
      return
    }
    if (result.menuName === deletePlaylistMenuKey) {
      await confirmDeleteNode(node)
    }
  }

  return {
    showFailureDialog,
    createEmptyPlaylist,
    createFolder,
    renameNode,
    deleteNode,
    openCreatePlaylistDialog,
    openCreateFolderDialog,
    openRenameNodeDialog,
    confirmDeleteNode,
    contextmenuEvent,
    handleNodeContextmenu
  }
}
