<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import pioneerDeviceLibraryItem from '@renderer/components/pioneerDeviceLibraryItem.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import confirm from '@renderer/components/confirmDialog'
import openRekordboxDesktopCreateNodeDialog from '@renderer/components/rekordboxDesktopCreateNodeDialog'
import RekordboxDesktopWritingOverlay from '@renderer/components/RekordboxDesktopWritingOverlay.vue'
import { ensureRekordboxDesktopWriteAvailable } from '@renderer/utils/rekordboxDesktopWriteAvailability'
import {
  buildRekordboxSourceCacheKey,
  clearRekordboxSourceCachesByKind,
  setCachedRekordboxSourceTree
} from '@renderer/utils/rekordboxLibraryCache'
import { t } from '@renderer/utils/translate'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'
import type {
  RekordboxDesktopCreateEmptyPlaylistResponse,
  RekordboxDesktopCreateFolderResponse,
  RekordboxDesktopDeletePlaylistResponse,
  RekordboxDesktopMovePlaylistResponse,
  RekordboxDesktopRenamePlaylistResponse
} from '@shared/rekordboxDesktopPlaylist'

const runtime = useRuntimeStore()
const collapseButtonRef = useTemplateRef<HTMLDivElement>('collapseButtonRef')
const playlistSearch = ref('')
const expandedFolderIds = ref<Set<number>>(new Set())
const dialogWriting = ref(false)
const dragSourceId = ref<number | null>(null)
const dragTarget = ref<{
  nodeId: number
  approach: '' | 'top' | 'center' | 'bottom'
} | null>(null)
const isDesktopSource = computed(
  () => runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop'
)
const renameMenuKey = 'common.rename'
const deleteFolderMenuKey = 'rekordboxDesktop.deleteFolderAction'
const deletePlaylistMenuKey = 'playlist.deletePlaylist'

const title = computed(() => {
  if (runtime.pioneerDeviceLibrary.selectedSourceName) {
    return runtime.pioneerDeviceLibrary.selectedSourceName
  }
  return isDesktopSource.value ? 'Rekordbox 本机库' : 'Pioneer USB'
})
const originalTreeNodes = computed(() => runtime.pioneerDeviceLibrary.treeNodes || [])

const normalizeKeyword = (value: string) =>
  String(value || '')
    .trim()
    .toLowerCase()

const sanitizeNodeName = (value: string) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')

const calculateDragApproach = (offsetY: number, isFolder: boolean): 'top' | 'center' | 'bottom' => {
  if (!isFolder) {
    return offsetY <= 12 ? 'top' : 'bottom'
  }
  if (offsetY <= 8) return 'top'
  if (offsetY < 16) return 'center'
  return 'bottom'
}

const findNodeById = (
  nodes: IPioneerPlaylistTreeNode[],
  nodeId: number
): IPioneerPlaylistTreeNode | null => {
  const walk = (items: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode | null => {
    for (const item of items) {
      if (item.id === nodeId) return item
      const children = Array.isArray(item.children) ? item.children : []
      const matched = walk(children)
      if (matched) return matched
    }
    return null
  }
  return walk(nodes)
}

const countNodeDescendants = (node: IPioneerPlaylistTreeNode) => {
  const summary = {
    folderCount: 0,
    playlistCount: 0
  }

  const walk = (items: IPioneerPlaylistTreeNode[]) => {
    for (const item of items) {
      if (item.isFolder) {
        summary.folderCount += 1
        if (Array.isArray(item.children) && item.children.length > 0) {
          walk(item.children)
        }
        continue
      }
      if (!item.isSmartPlaylist) {
        summary.playlistCount += 1
      }
    }
  }

  walk(Array.isArray(node.children) ? node.children : [])
  return summary
}

const cloneTreeNodes = (nodes: IPioneerPlaylistTreeNode[]) =>
  JSON.parse(JSON.stringify(nodes)) as IPioneerPlaylistTreeNode[]

const findNodeLocation = (
  nodes: IPioneerPlaylistTreeNode[],
  nodeId: number,
  parentId = 0
): {
  node: IPioneerPlaylistTreeNode
  siblings: IPioneerPlaylistTreeNode[]
  index: number
  parentId: number
} | null => {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]
    if (node.id === nodeId) {
      return {
        node,
        siblings: nodes,
        index,
        parentId
      }
    }
    const children = Array.isArray(node.children) ? node.children : []
    const matched = findNodeLocation(children, nodeId, node.id)
    if (matched) return matched
  }
  return null
}

const isDescendantNode = (
  nodes: IPioneerPlaylistTreeNode[],
  sourceId: number,
  targetId: number
): boolean => {
  const source = findNodeById(nodes, sourceId)
  if (!source || !Array.isArray(source.children) || source.children.length === 0) return false
  const walk = (items: IPioneerPlaylistTreeNode[]): boolean => {
    for (const item of items) {
      if (item.id === targetId) return true
      if (Array.isArray(item.children) && item.children.length > 0 && walk(item.children)) {
        return true
      }
    }
    return false
  }
  return walk(source.children)
}

const reorderTreeNodes = (nodes: IPioneerPlaylistTreeNode[]) => {
  nodes.forEach((node, index) => {
    node.order = index + 1
    if (Array.isArray(node.children) && node.children.length > 0) {
      reorderTreeNodes(node.children)
    }
  })
}

const moveTreeNode = (
  nodes: IPioneerPlaylistTreeNode[],
  sourceId: number,
  targetId: number,
  approach: 'top' | 'center' | 'bottom'
): {
  nodes: IPioneerPlaylistTreeNode[]
  playlistId: number
  parentId: number
  seq: number
} | null => {
  const nextNodes = cloneTreeNodes(nodes)
  const sourceBeforeMove = findNodeLocation(nextNodes, sourceId)
  if (!sourceBeforeMove) return null

  const originalParentId = sourceBeforeMove.parentId
  const originalSeq = sourceBeforeMove.index + 1
  const [movedNode] = sourceBeforeMove.siblings.splice(sourceBeforeMove.index, 1)
  if (!movedNode) return null

  if (approach === 'center') {
    const folderTarget = findNodeById(nextNodes, targetId)
    if (!folderTarget || !folderTarget.isFolder) return null
    folderTarget.children = Array.isArray(folderTarget.children) ? folderTarget.children : []
    movedNode.parentId = folderTarget.id
    folderTarget.children.unshift(movedNode)
  } else {
    const targetAfterRemoval = findNodeLocation(nextNodes, targetId)
    if (!targetAfterRemoval) return null
    const nextParentId = targetAfterRemoval.parentId
    const nextSeq = targetAfterRemoval.index + (approach === 'bottom' ? 2 : 1)
    movedNode.parentId = nextParentId
    targetAfterRemoval.siblings.splice(nextSeq - 1, 0, movedNode)
  }

  reorderTreeNodes(nextNodes)
  const movedAfter = findNodeLocation(nextNodes, sourceId)
  if (!movedAfter) return null

  const finalParentId = movedAfter.parentId
  const finalSeq = movedAfter.index + 1
  if (finalParentId === originalParentId && finalSeq === originalSeq) {
    return null
  }

  return {
    nodes: nextNodes,
    playlistId: sourceId,
    parentId: finalParentId,
    seq: finalSeq
  }
}

const isPlayablePlaylistNode = (
  node: IPioneerPlaylistTreeNode | null | undefined
): node is IPioneerPlaylistTreeNode => Boolean(node && !node.isFolder && !node.isSmartPlaylist)

const isMovableTreeNode = (node: IPioneerPlaylistTreeNode | null | undefined) =>
  Boolean(node && !node.isSmartPlaylist)

const runWithDialogWriting = async <T,>(task: () => Promise<T>): Promise<T> => {
  dialogWriting.value = true
  try {
    return await task()
  } finally {
    dialogWriting.value = false
  }
}

const syncRuntimeDesktopTree = (nodes: IPioneerPlaylistTreeNode[], preferredPlaylistId = 0) => {
  const sourceKey = String(runtime.pioneerDeviceLibrary.selectedSourceKey || '').trim()
  const rootPath = String(runtime.pioneerDeviceLibrary.selectedSourceRootPath || '').trim()
  if (!sourceKey || !rootPath) return

  const sourceCacheKey = buildRekordboxSourceCacheKey({
    sourceKind: 'desktop',
    sourceKey,
    rootPath,
    libraryType: runtime.pioneerDeviceLibrary.selectedLibraryType || 'masterDb'
  })
  setCachedRekordboxSourceTree(sourceCacheKey, nodes, {
    selectedPlaylistId: preferredPlaylistId
  })
  if (runtime.pioneerDeviceLibrary.selectedSourceKind !== 'desktop') return
  runtime.pioneerDeviceLibrary.treeNodes = nodes
  runtime.pioneerDeviceLibrary.selectedPlaylistId = preferredPlaylistId
}

const refreshDesktopTree = async (preferredPlaylistId = 0) => {
  const result = (await window.electron.ipcRenderer.invoke(
    buildRekordboxSourceChannel('desktop', 'load-tree')
  )) as {
    treeNodes?: IPioneerPlaylistTreeNode[]
  }
  const treeNodes = Array.isArray(result?.treeNodes) ? result.treeNodes : []
  const preferredNode =
    preferredPlaylistId > 0 ? findNodeById(treeNodes, preferredPlaylistId) : null
  const currentSelectedNode =
    Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) > 0
      ? findNodeById(treeNodes, Number(runtime.pioneerDeviceLibrary.selectedPlaylistId))
      : null
  const nextSelectedId =
    preferredPlaylistId > 0 && isPlayablePlaylistNode(preferredNode)
      ? preferredPlaylistId
      : isPlayablePlaylistNode(currentSelectedNode)
        ? Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
        : 0
  syncRuntimeDesktopTree(treeNodes, nextSelectedId)
}

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

const filterTreeByPlaylistName = (
  nodes: IPioneerPlaylistTreeNode[],
  keyword: string
): IPioneerPlaylistTreeNode[] => {
  const normalizedKeyword = keyword.trim().toLowerCase()
  if (!normalizedKeyword) return nodes

  const walk = (items: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode[] => {
    const result: IPioneerPlaylistTreeNode[] = []
    for (const item of items) {
      const children = Array.isArray(item.children) ? walk(item.children) : []
      if (item.isFolder) {
        if (children.length > 0) {
          result.push({
            ...item,
            children
          })
        }
        continue
      }
      if (item.name.toLowerCase().includes(normalizedKeyword)) {
        result.push({
          ...item,
          children: []
        })
      }
    }
    return result
  }

  return walk(nodes)
}

const visibleTreeNodes = computed(() =>
  filterTreeByPlaylistName(originalTreeNodes.value, String(playlistSearch.value || ''))
)

const showHint = computed(
  () =>
    !runtime.pioneerDeviceLibrary.loading &&
    !visibleTreeNodes.value.length &&
    !String(playlistSearch.value || '').trim()
)

const statusText = computed(() => {
  if (runtime.pioneerDeviceLibrary.loading) {
    return isDesktopSource.value
      ? t('rekordboxDesktop.loadingPlaylistTree')
      : t('pioneer.loadingPlaylistTree')
  }
  if (String(playlistSearch.value || '').trim() && !visibleTreeNodes.value.length) {
    return t('pioneer.noMatchingPlaylists')
  }
  return isDesktopSource.value
    ? t('rekordboxDesktop.emptyPlaylistTree')
    : t('pioneer.emptyPlaylistTree')
})

const createEmptyPlaylist = async (playlistName: string, parentId = 0) => {
  if (!isDesktopSource.value || dialogWriting.value) return false
  return await runWithDialogWriting(async () => {
    if (!(await ensureRekordboxDesktopWriteAvailable('create'))) return false
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
    await refreshDesktopTree(response.summary.playlistId)
    return true
  })
}

const createFolder = async (folderName: string, parentId = 0) => {
  if (!isDesktopSource.value || dialogWriting.value) return false
  return await runWithDialogWriting(async () => {
    if (!(await ensureRekordboxDesktopWriteAvailable('create'))) return false
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
    await refreshDesktopTree(Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0)
    const nextExpanded = new Set(expandedFolderIds.value)
    if (parentId > 0) nextExpanded.add(parentId)
    nextExpanded.add(response.summary.folderId)
    expandedFolderIds.value = nextExpanded
    return true
  })
}

const renameNode = async (node: IPioneerPlaylistTreeNode, nextName: string) => {
  if (!isDesktopSource.value || dialogWriting.value) return false
  const playlistId = Number(node.id) || 0
  const name = sanitizeNodeName(nextName)
  if (playlistId <= 0 || !name) return false
  if (name === sanitizeNodeName(node.name)) return true

  return await runWithDialogWriting(async () => {
    if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return false
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
    await refreshDesktopTree(Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || playlistId)
    return true
  })
}

const deleteNode = async (node: IPioneerPlaylistTreeNode) => {
  if (!isDesktopSource.value || dialogWriting.value) return false
  const playlistId = Number(node.id) || 0
  if (playlistId <= 0) return false

  return await runWithDialogWriting(async () => {
    if (!(await ensureRekordboxDesktopWriteAvailable('edit'))) return false
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
    const deletedSelected =
      Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) === playlistId ? 0 : undefined
    await refreshDesktopTree(deletedSelected ?? (response.summary.parentId || 0))
    return true
  })
}

const openCreatePlaylistDialog = async (parentId = 0, defaultValue = '') => {
  if (!isDesktopSource.value || dialogWriting.value) return
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
  if (!isDesktopSource.value || dialogWriting.value) return
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
  if (!isDesktopSource.value || dialogWriting.value || node.isSmartPlaylist) return
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
  if (!isDesktopSource.value || dialogWriting.value || node.isSmartPlaylist) return

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

const toggleFolder = (node: IPioneerPlaylistTreeNode) => {
  if (dialogWriting.value) return
  if (!node.isFolder) return
  const next = new Set(expandedFolderIds.value)
  if (next.has(node.id)) next.delete(node.id)
  else next.add(node.id)
  expandedFolderIds.value = next
}

const selectPlaylist = (node: IPioneerPlaylistTreeNode) => {
  if (dialogWriting.value || node.isFolder || node.isSmartPlaylist) return
  runtime.pioneerDeviceLibrary.selectedPlaylistId =
    runtime.pioneerDeviceLibrary.selectedPlaylistId === node.id ? 0 : node.id
}

const collapseAllHandleClick = async () => {
  if (dialogWriting.value) return
  expandedFolderIds.value = new Set()
  await nextTick()
}

const contextmenuEvent = async (event: MouseEvent) => {
  if (!isDesktopSource.value || dialogWriting.value) return
  const menuArr = [[{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]]
  const result = await rightClickMenu({ menuArr, clickEvent: event })
  if (result === 'cancel') return
  if (result.menuName === 'library.createPlaylist') {
    await openCreatePlaylistDialog(0)
    return
  }
  if (result.menuName === 'library.createFolder') {
    await openCreateFolderDialog(0)
  }
}

const handleNodeContextmenu = async (event: MouseEvent, node: IPioneerPlaylistTreeNode) => {
  if (!isDesktopSource.value || dialogWriting.value || node.isSmartPlaylist) return
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

const resetDragState = () => {
  dragSourceId.value = null
  dragTarget.value = null
}

const handleDragStartNode = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  if (
    !isDesktopSource.value ||
    dialogWriting.value ||
    !isMovableTreeNode(node) ||
    normalizeKeyword(playlistSearch.value)
  ) {
    event.preventDefault()
    return
  }
  dragSourceId.value = node.id
  dragTarget.value = null
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(node.id))
  }
}

const updateDragTarget = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  if (!isDesktopSource.value || dialogWriting.value) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    dragTarget.value = null
    return
  }
  if (!event.dataTransfer || dragSourceId.value === null) return
  if (!isMovableTreeNode(node) || normalizeKeyword(playlistSearch.value)) {
    event.dataTransfer.dropEffect = 'none'
    dragTarget.value = null
    return
  }
  if (node.id === dragSourceId.value) {
    event.dataTransfer.dropEffect = 'none'
    dragTarget.value = null
    return
  }
  if (isDescendantNode(originalTreeNodes.value, dragSourceId.value, node.id)) {
    event.dataTransfer.dropEffect = 'none'
    dragTarget.value = null
    return
  }
  const approach = calculateDragApproach(event.offsetY, node.isFolder)
  if (approach === 'center' && !node.isFolder) {
    event.dataTransfer.dropEffect = 'none'
    dragTarget.value = null
    return
  }
  event.dataTransfer.dropEffect = 'move'
  dragTarget.value = {
    nodeId: node.id,
    approach
  }
}

const handleDragOverNode = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  updateDragTarget(event, node)
}

const handleDragEnterNode = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  updateDragTarget(event, node)
}

const handleDragLeaveNode = (_event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  if (dialogWriting.value) return
  if (dragTarget.value?.nodeId === node.id) {
    dragTarget.value = null
  }
}

const handleDragEndNode = () => {
  if (dialogWriting.value) return
  resetDragState()
}

const handleDropNode = async (_event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  if (!isDesktopSource.value || dialogWriting.value) {
    resetDragState()
    return
  }
  if (dragSourceId.value === null || !dragTarget.value) {
    resetDragState()
    return
  }

  const sourceId = dragSourceId.value
  const targetState = { ...dragTarget.value }
  resetDragState()
  if (!targetState.approach) return

  const moved = moveTreeNode(originalTreeNodes.value, sourceId, node.id, targetState.approach)
  if (!moved) return

  const previousTree = cloneTreeNodes(originalTreeNodes.value)
  syncRuntimeDesktopTree(moved.nodes, sourceId)

  await runWithDialogWriting(async () => {
    if (!(await ensureRekordboxDesktopWriteAvailable('move'))) {
      syncRuntimeDesktopTree(previousTree, sourceId)
      return
    }

    const response = (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'move-playlist'),
      {
        playlistId: moved.playlistId,
        parentId: moved.parentId,
        seq: moved.seq
      }
    )) as RekordboxDesktopMovePlaylistResponse

    if (!response.ok) {
      syncRuntimeDesktopTree(previousTree, sourceId)
      await showFailureDialog(response.summary.errorMessage, response.summary.logPath)
      return
    }

    clearRekordboxSourceCachesByKind('desktop')
    await refreshDesktopTree(sourceId)
  })
}

const lastTreeSignature = ref('')
const buildTreeSignature = (nodes: IPioneerPlaylistTreeNode[]) =>
  nodes.map((node) => `${node.id}:${node.order}:${node.children?.length || 0}`).join('|')

const hasPlaylistInTree = (nodes: IPioneerPlaylistTreeNode[], playlistId: number): boolean => {
  if (!playlistId) return false
  const walk = (items: IPioneerPlaylistTreeNode[]): boolean => {
    for (const item of items) {
      if (!item.isFolder && item.id === playlistId) return true
      if (Array.isArray(item.children) && item.children.length > 0 && walk(item.children)) {
        return true
      }
    }
    return false
  }
  return walk(nodes)
}

const syncExpandedWhenTreeChanges = () => {
  const signature = buildTreeSignature(originalTreeNodes.value)
  if (signature === lastTreeSignature.value) return
  lastTreeSignature.value = signature
  expandedFolderIds.value = new Set()
  const currentSelectedPlaylistId = Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
  if (
    currentSelectedPlaylistId > 0 &&
    hasPlaylistInTree(originalTreeNodes.value, currentSelectedPlaylistId)
  ) {
    return
  }
  runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
}

watch(
  originalTreeNodes,
  () => {
    syncExpandedWhenTreeChanges()
  },
  { immediate: true, deep: false }
)
</script>

<template>
  <div class="content" @contextmenu.stop.prevent="contextmenuEvent($event)">
    <div class="unselectable libraryTitle">
      <span class="libraryTitleText">{{ title }}</span>
      <div style="display: flex; justify-content: center; align-items: center">
        <div
          ref="collapseButtonRef"
          class="collapseButton"
          :class="{ disabledAction: dialogWriting }"
          @click="collapseAllHandleClick()"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            xmlns="http://www.w3.org/2000/svg"
            fill="currentColor"
          >
            <path d="M9 9H4v1h5V9z" />
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"
            />
          </svg>
        </div>
        <bubbleBox :dom="collapseButtonRef || undefined" :title="t('playlist.collapsibleFolder')" />
      </div>
    </div>

    <div class="librarySearchWrapper">
      <div class="searchRow">
        <div class="searchInputWrapper">
          <input
            v-model="playlistSearch"
            class="searchInput"
            :placeholder="t('playlist.searchPlaylists')"
            :disabled="dialogWriting"
          />
          <div
            v-show="String(playlistSearch || '').length"
            class="clearBtn"
            :class="{ clearBtnDisabled: dialogWriting }"
            @click="!dialogWriting && (playlistSearch = '')"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              shape-rendering="geometricPrecision"
            >
              <path
                d="M3 3 L9 9 M9 3 L3 9"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                vector-effect="non-scaling-stroke"
              />
            </svg>
          </div>
        </div>
      </div>
    </div>

    <div class="unselectable libraryArea">
      <OverlayScrollbarsComponent
        :options="{
          scrollbars: {
            autoHide: 'leave' as const,
            autoHideDelay: 50,
            clickScroll: true
          } as const,
          overflow: {
            x: 'hidden',
            y: 'scroll'
          } as const
        }"
        element="div"
        style="height: 100%; width: 100%"
        defer
      >
        <template v-for="item of visibleTreeNodes" :key="`${item.id}:${item.order}`">
          <pioneerDeviceLibraryItem
            :node="item"
            :depth="0"
            :expanded-ids="expandedFolderIds"
            :filter-text="playlistSearch"
            :interaction-disabled="dialogWriting"
            :draggable-nodes="isDesktopSource && !normalizeKeyword(playlistSearch)"
            :drag-target-node-id="dragTarget?.nodeId || undefined"
            :drag-target-approach="dragTarget?.approach || ''"
            :drag-source-id="dragSourceId || undefined"
            @toggle-folder="toggleFolder"
            @select-playlist="selectPlaylist"
            @contextmenu-node="handleNodeContextmenu"
            @dragstart-node="handleDragStartNode"
            @dragover-node="handleDragOverNode"
            @dragenter-node="handleDragEnterNode"
            @dragleave-node="handleDragLeaveNode"
            @drop-node="handleDropNode"
            @dragend-node="handleDragEndNode"
          />
        </template>

        <div
          style="
            flex-grow: 1;
            min-height: 30px;
            display: flex;
            justify-content: center;
            align-items: center;
          "
        >
          <span
            v-show="
              (showHint ||
                (playlistSearch && !visibleTreeNodes.length) ||
                runtime.pioneerDeviceLibrary.loading) &&
              runtime.layoutConfig.libraryAreaWidth !== 0
            "
            style="font-size: 12px; color: var(--text-weak); position: absolute; bottom: 50vh"
          >
            {{ statusText }}
          </span>
        </div>
      </OverlayScrollbarsComponent>
    </div>

    <RekordboxDesktopWritingOverlay v-if="dialogWriting" />
  </div>
</template>

<style lang="scss" scoped>
.content {
  position: relative;
}

.libraryArea {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
}

.content {
  height: 100%;
  width: 100%;
  display: flex;
  flex-grow: 1;
  min-height: 0;
  background-color: var(--bg);
  overflow: hidden;
  flex-direction: column;

  .libraryTitle {
    height: 35px;
    line-height: 35px;
    padding: 0 18px 0 20px;
    font-size: 12px;
    font-weight: bold;
    display: flex;
    justify-content: space-between;
  }

  .libraryTitleText {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .collapseButton {
    color: var(--text);
    width: 20px;
    height: 20px;
    display: flex;
    justify-content: center;
    align-items: center;
    border-radius: 5px;

    &:hover {
      background-color: var(--hover);
    }
  }
}

.disabledAction {
  pointer-events: none;
  opacity: 0.6;
}

.librarySearchWrapper {
  flex-shrink: 0;
  padding: 6px 5px 6px 5px;
  background-color: var(--bg);
}

.searchInput {
  width: 100%;
  height: 22px;
  line-height: 22px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  border-radius: 2px;
  padding: 0 8px;
  box-sizing: border-box;
  font-size: 12px;
  font-weight: normal;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }

  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
}

.searchInputWrapper:hover .searchInput {
  background-color: var(--hover);
  border-color: var(--accent);
}

.searchRow {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
}

.searchRow .searchInput {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}

.searchInputWrapper {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}

.searchInputWrapper .searchInput {
  width: 100%;
  padding-right: 24px;
}

.clearBtn {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  display: flex;
  justify-content: center;
  align-items: center;
  border-radius: 50%;
  color: var(--text-weak);
  cursor: pointer;

  &:hover {
    color: var(--text);
    background-color: var(--hover);
  }
}

.clearBtnDisabled {
  pointer-events: none;
  opacity: 0.45;
}
</style>
