<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  useTemplateRef,
  watch,
  type ComponentPublicInstance
} from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import confirm from '@renderer/components/confirmDialog'
import hotkeys from 'hotkeys-js'
import listIconAsset from '@renderer/assets/listIcon.svg?asset'
import openRekordboxDesktopCreateNodeDialog from '@renderer/components/rekordboxDesktopCreateNodeDialog'
import RekordboxDesktopTargetTreeItem from '@renderer/components/rekordboxDesktopTargetTreeItem.vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import {
  buildVisibleCombinedNavList,
  loadRecentDialogSelectedSongListUUIDs,
  persistRecentDialogSelectedSongListUUIDs,
  resolveDialogNavIndexByUUID,
  resolveDialogNavMove,
  type DialogNavItem
} from '@renderer/components/selectSongListDialogNav'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { ensureRekordboxDesktopWriteAvailable } from '@renderer/utils/rekordboxDesktopWriteAvailability'
import {
  buildRekordboxSourceCacheKey,
  clearRekordboxSourceCachesByKind,
  setCachedRekordboxSourceTree
} from '@renderer/utils/rekordboxLibraryCache'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { buildRekordboxSourceChannel } from '@shared/rekordboxSources'
import { v4 as uuidV4 } from 'uuid'
import type { IDir, IPioneerPlaylistTreeNode } from '../../../types/globals'
import type {
  RekordboxDesktopCreateEmptyPlaylistResponse,
  RekordboxDesktopCreateFolderResponse,
  RekordboxDesktopDeletePlaylistResponse,
  RekordboxDesktopMovePlaylistResponse,
  RekordboxDesktopPlaylistWriteTarget,
  RekordboxDesktopRenamePlaylistResponse
} from '@shared/rekordboxDesktopPlaylist'

type DialogPayload = {
  target: RekordboxDesktopPlaylistWriteTarget
}

type LoadTreeResult = {
  treeNodes?: IPioneerPlaylistTreeNode[]
  sourceKey?: string
  sourceRootPath?: string
}

type PreventableEvent = {
  preventDefault?: () => void
}

type PseudoSongList = IDir

const RECENT_LIBRARY_KEY = 'RekordboxDesktopLibrary'
const uuid = uuidV4()
const runtime = useRuntimeStore()
const renameMenuKey = 'common.rename'
const deleteFolderMenuKey = 'rekordboxDesktop.deleteFolderAction'
const deletePlaylistMenuKey = 'playlist.deletePlaylist'

const props = defineProps<{
  dialogTitle: string
  defaultPlaylistName: string
  trackCount?: number
  confirmCallback: (payload: DialogPayload) => void
  cancelCallback: () => void
}>()

runtime.activeMenuUUID = ''
runtime.selectSongListDialogShow = true

const { dialogVisible, closeWithAnimation } = useDialogTransition()
const collapseButtonRef = useTemplateRef<HTMLDivElement>('collapseButtonRef')
const searchInputRef = useTemplateRef<HTMLInputElement>('searchInputRef')

const rawTreeNodes = ref<IPioneerPlaylistTreeNode[]>([])
const loading = ref(false)
const dialogWriting = ref(false)
const loadError = ref('')
const playlistSearch = ref('')
const expandedFolderIds = ref<Set<number>>(new Set())
const selectedArea = ref<'recent' | 'tree' | ''>('')
const navIndex = ref(-1)
const flashArea = ref('')
const recentRowRefs = new Map<string, HTMLElement>()
const dragSourceId = ref<number | null>(null)
const dragTarget = ref<{
  nodeId: number
  approach: '' | 'top' | 'center' | 'bottom'
} | null>(null)

let recentSelectedPlaylistIds = loadRecentDialogSelectedSongListUUIDs(
  RECENT_LIBRARY_KEY,
  runtime.setting.recentDialogSelectedSongListMaxCount ?? 10
)
if (recentSelectedPlaylistIds.length > 0) {
  runtime.dialogSelectedSongListUUID = recentSelectedPlaylistIds[0]
  selectedArea.value = 'recent'
}

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

const toPseudoSongList = (node: IPioneerPlaylistTreeNode): PseudoSongList => ({
  uuid: String(node.id),
  dirName: node.name,
  type: 'songList'
})

const resolveTemplateElement = (
  value: Element | ComponentPublicInstance | null
): HTMLElement | null => {
  if (value instanceof HTMLElement) return value
  if (!value || typeof value !== 'object' || !('$el' in value)) return null
  return value.$el instanceof HTMLElement ? value.$el : null
}

const setRecentRowRef = (id: string, el: Element | ComponentPublicInstance | null) => {
  const resolved = resolveTemplateElement(el)
  if (resolved) recentRowRefs.set(id, resolved)
  else recentRowRefs.delete(id)
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
  const targetBeforeMove = findNodeLocation(nextNodes, targetId)
  if (!sourceBeforeMove || !targetBeforeMove) return null

  const originalParentId = sourceBeforeMove.parentId
  const originalSeq = sourceBeforeMove.index + 1

  const [movedNode] = sourceBeforeMove.siblings.splice(sourceBeforeMove.index, 1)
  if (!movedNode) return null

  let nextParentId = 0
  let nextSeq = 1

  if (approach === 'center') {
    const folderTarget = findNodeById(nextNodes, targetId)
    if (!folderTarget || !folderTarget.isFolder) return null
    folderTarget.children = Array.isArray(folderTarget.children) ? folderTarget.children : []
    nextParentId = folderTarget.id
    nextSeq = 1
    movedNode.parentId = nextParentId
    folderTarget.children.unshift(movedNode)
  } else {
    const targetAfterRemoval = findNodeLocation(nextNodes, targetId)
    if (!targetAfterRemoval) return null
    nextParentId = targetAfterRemoval.parentId
    nextSeq = targetAfterRemoval.index + (approach === 'bottom' ? 2 : 1)
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

const flattenPlayableNodes = (nodes: IPioneerPlaylistTreeNode[]) => {
  const result: IPioneerPlaylistTreeNode[] = []
  const walk = (items: IPioneerPlaylistTreeNode[]) => {
    for (const item of items) {
      if (isPlayablePlaylistNode(item)) result.push(item)
      if (Array.isArray(item.children) && item.children.length > 0) {
        walk(item.children)
      }
    }
  }
  walk(nodes)
  return result
}

const filterTreeNodes = (nodes: IPioneerPlaylistTreeNode[], keyword: string) => {
  const normalizedKeyword = normalizeKeyword(keyword)
  if (!normalizedKeyword) {
    const stripSmart = (items: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode[] =>
      items
        .map((item) => {
          if (item.isFolder) {
            return {
              ...item,
              children: stripSmart(Array.isArray(item.children) ? item.children : [])
            }
          }
          return item
        })
        .filter((item) => item.isFolder || !item.isSmartPlaylist)
    return stripSmart(nodes)
  }

  const walk = (items: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode[] => {
    const result: IPioneerPlaylistTreeNode[] = []
    for (const item of items) {
      if (item.isFolder) {
        const children = walk(Array.isArray(item.children) ? item.children : [])
        if (children.length > 0) {
          result.push({
            ...item,
            children
          })
        }
        continue
      }
      if (item.isSmartPlaylist) continue
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

const collectFolderIds = (nodes: IPioneerPlaylistTreeNode[]) => {
  const ids: number[] = []
  const walk = (items: IPioneerPlaylistTreeNode[]) => {
    for (const item of items) {
      if (item.isFolder) ids.push(item.id)
      if (Array.isArray(item.children) && item.children.length > 0) {
        walk(item.children)
      }
    }
  }
  walk(nodes)
  return ids
}

const filteredTreeNodes = computed(() => filterTreeNodes(rawTreeNodes.value, playlistSearch.value))
const visibleTreeNodes = computed(() => filteredTreeNodes.value)
const allPlaylistNodes = computed(() => flattenPlayableNodes(rawTreeNodes.value))
const renderedExpandedFolderIds = computed(() => {
  const next = !playlistSearch.value.trim()
    ? new Set(expandedFolderIds.value)
    : new Set(collectFolderIds(filteredTreeNodes.value))
  return next
})

const recentPlaylistArr = computed<PseudoSongList[]>(() => {
  const result: PseudoSongList[] = []
  const invalidIds: string[] = []
  for (const item of recentSelectedPlaylistIds) {
    const node = findNodeById(rawTreeNodes.value, Number(item) || 0)
    if (!isPlayablePlaylistNode(node)) {
      invalidIds.push(item)
      continue
    }
    result.push(toPseudoSongList(node))
  }
  if (invalidIds.length > 0) {
    recentSelectedPlaylistIds = recentSelectedPlaylistIds.filter(
      (item) => !invalidIds.includes(item)
    )
    persistRecentDialogSelectedSongListUUIDs(RECENT_LIBRARY_KEY, recentSelectedPlaylistIds)
  }
  return result
})

const allSongListArr = computed<PseudoSongList[]>(() =>
  allPlaylistNodes.value.map(toPseudoSongList)
)

const visibleCombinedNavList = computed<DialogNavItem[]>(() =>
  buildVisibleCombinedNavList(
    recentPlaylistArr.value,
    allSongListArr.value,
    String(playlistSearch.value || '')
  )
)

const syncNavIndexByUUID = () => {
  const list = visibleCombinedNavList.value || []
  navIndex.value = resolveDialogNavIndexByUUID(
    list,
    runtime.dialogSelectedSongListUUID,
    selectedArea.value
  )
}

const moveSelection = (direction: 1 | -1) => {
  const list = visibleCombinedNavList.value || []
  if (list.length === 0) return
  navIndex.value = resolveDialogNavMove(navIndex.value, direction, list.length)
  const target = list[navIndex.value]
  selectedArea.value = target.area
  runtime.dialogSelectedSongListUUID = target.uuid
}

const handleMoveDown = (e?: PreventableEvent | null) => {
  if (dialogWriting.value) return
  try {
    e?.preventDefault?.()
  } catch {}
  moveSelection(1)
}

const handleMoveUp = (e?: PreventableEvent | null) => {
  if (dialogWriting.value) return
  try {
    e?.preventDefault?.()
  } catch {}
  moveSelection(-1)
}

const exactMatchExists = computed(() => {
  const keyword = normalizeKeyword(playlistSearch.value)
  if (!keyword) return true
  return allSongListArr.value.some((item) => String(item.dirName || '').toLowerCase() === keyword)
})

const showCreateNow = computed(() => {
  const keyword = String(playlistSearch.value || '').trim()
  return Boolean(keyword) && !exactMatchExists.value
})

const searchKeyword = computed(() => normalizeKeyword(playlistSearch.value))

const filteredRecentPlaylistArr = computed(() => {
  if (!searchKeyword.value) return recentPlaylistArr.value
  return recentPlaylistArr.value.filter((item) =>
    String(item.dirName || '')
      .toLowerCase()
      .includes(searchKeyword.value)
  )
})

const filteredAllSongListIds = computed(() =>
  allSongListArr.value
    .filter((item) =>
      !searchKeyword.value
        ? true
        : String(item.dirName || '')
            .toLowerCase()
            .includes(searchKeyword.value)
    )
    .map((item) => item.uuid)
)

const flashBorder = (name: string) => {
  flashArea.value = name
  let count = 0
  const interval = window.setInterval(() => {
    count += 1
    if (count >= 3) {
      window.clearInterval(interval)
      flashArea.value = ''
    }
  }, 500)
}

const runWithDialogWriting = async <T,>(task: () => Promise<T>): Promise<T> => {
  dialogWriting.value = true
  try {
    return await task()
  } finally {
    dialogWriting.value = false
  }
}

const syncRuntimeDesktopTree = (result: LoadTreeResult, preferredPlaylistId = 0) => {
  const sourceKey = String(
    result.sourceKey || runtime.pioneerDeviceLibrary.selectedSourceKey || ''
  ).trim()
  const rootPath = String(
    result.sourceRootPath || runtime.pioneerDeviceLibrary.selectedSourceRootPath || ''
  ).trim()
  if (!sourceKey || !rootPath) return

  const sourceCacheKey = buildRekordboxSourceCacheKey({
    sourceKind: 'desktop',
    sourceKey,
    rootPath,
    libraryType: 'masterDb'
  })
  setCachedRekordboxSourceTree(sourceCacheKey, rawTreeNodes.value, {
    selectedPlaylistId: preferredPlaylistId
  })
  if (runtime.pioneerDeviceLibrary.selectedSourceKind !== 'desktop') return
  runtime.pioneerDeviceLibrary.treeNodes = rawTreeNodes.value
  runtime.pioneerDeviceLibrary.selectedPlaylistId = preferredPlaylistId
}

const loadTree = async (preferredPlaylistId = Number(runtime.dialogSelectedSongListUUID) || 0) => {
  loading.value = true
  loadError.value = ''
  try {
    const result = (await window.electron.ipcRenderer.invoke(
      buildRekordboxSourceChannel('desktop', 'load-tree')
    )) as LoadTreeResult
    rawTreeNodes.value = Array.isArray(result?.treeNodes) ? result.treeNodes : []

    const nextSelectedId =
      preferredPlaylistId > 0 &&
      isPlayablePlaylistNode(findNodeById(rawTreeNodes.value, preferredPlaylistId))
        ? preferredPlaylistId
        : Number(allSongListArr.value[0]?.uuid) || 0

    runtime.dialogSelectedSongListUUID = nextSelectedId > 0 ? String(nextSelectedId) : ''
    if (nextSelectedId > 0 && !selectedArea.value) {
      selectedArea.value = 'tree'
    }
    syncRuntimeDesktopTree(result, nextSelectedId)
  } catch (error) {
    loadError.value =
      error instanceof Error ? error.message : String(error || t('common.unknownError'))
    rawTreeNodes.value = []
    runtime.dialogSelectedSongListUUID = ''
  } finally {
    loading.value = false
  }
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

const contextmenuEvent = async (event: MouseEvent, parentId = 0) => {
  if (dialogWriting.value) return
  const menuArr = [[{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]]
  const result = await rightClickMenu({ menuArr, clickEvent: event })
  if (result === 'cancel') return
  if (result.menuName === 'library.createPlaylist') {
    await openCreatePlaylistDialog(
      parentId,
      parentId <= 0 ? String(playlistSearch.value || '').trim() || props.defaultPlaylistName : ''
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

const createNow = async () => {
  if (dialogWriting.value) return
  const playlistName = String(playlistSearch.value || '').trim()
  if (!playlistName) return
  await openCreatePlaylistDialog(0, playlistName)
}

const clearSearch = () => {
  if (dialogWriting.value) return
  playlistSearch.value = ''
}

const collapseButtonHandleClick = async () => {
  if (dialogWriting.value) return
  expandedFolderIds.value = new Set()
  await nextTick()
}

const selectRecentPlaylist = (playlistId: string) => {
  if (dialogWriting.value) return
  runtime.dialogSelectedSongListUUID = playlistId
  selectedArea.value = 'recent'
}

const confirmRecentPlaylist = () => {
  if (dialogWriting.value) return
  confirmHandle()
}

const selectPlaylist = (node: IPioneerPlaylistTreeNode) => {
  if (dialogWriting.value) return
  if (!isPlayablePlaylistNode(node)) return
  runtime.dialogSelectedSongListUUID = String(node.id)
  selectedArea.value = 'tree'
}

const toggleFolder = (node: IPioneerPlaylistTreeNode) => {
  if (dialogWriting.value) return
  if (!node.isFolder) return
  const next = new Set(expandedFolderIds.value)
  if (next.has(node.id)) next.delete(node.id)
  else next.add(node.id)
  expandedFolderIds.value = next
}

const resolveNodeDragApproach = (nodeId: number) =>
  dragTarget.value?.nodeId === nodeId ? dragTarget.value.approach : ''

const isDraggingNode = (nodeId: number) => dragSourceId.value === nodeId

const resetDragState = () => {
  dragSourceId.value = null
  dragTarget.value = null
}

const handleDragStartNode = (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  if (dialogWriting.value || !isMovableTreeNode(node) || searchKeyword.value) {
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
  if (dialogWriting.value) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    dragTarget.value = null
    return
  }
  if (!event.dataTransfer || dragSourceId.value === null) return
  if (!isMovableTreeNode(node) || searchKeyword.value) {
    event.dataTransfer.dropEffect = 'none'
    dragTarget.value = null
    return
  }
  if (node.id === dragSourceId.value) {
    event.dataTransfer.dropEffect = 'none'
    dragTarget.value = null
    return
  }
  if (isDescendantNode(rawTreeNodes.value, dragSourceId.value, node.id)) {
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

const handleDropNode = async (event: DragEvent, node: IPioneerPlaylistTreeNode) => {
  if (dialogWriting.value) {
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

  const moved = moveTreeNode(rawTreeNodes.value, sourceId, node.id, targetState.approach)
  if (!moved) return

  const previousTree = cloneTreeNodes(rawTreeNodes.value)
  rawTreeNodes.value = moved.nodes
  selectedArea.value = 'tree'
  runtime.dialogSelectedSongListUUID = String(sourceId)

  await runWithDialogWriting(async () => {
    if (!(await ensureRekordboxDesktopWriteAvailable('move'))) {
      rawTreeNodes.value = previousTree
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
      rawTreeNodes.value = previousTree
      await showFailureDialog(response.summary.errorMessage, response.summary.logPath)
      return
    }

    clearRekordboxSourceCachesByKind('desktop')
    await loadTree(sourceId)
  })
}

const confirmHandle = () => {
  if (dialogWriting.value) return
  const selectedId = String(runtime.dialogSelectedSongListUUID || '').trim()
  const selectionVisible =
    !normalizeKeyword(playlistSearch.value) || filteredAllSongListIds.value.includes(selectedId)
  const selectedNode = findNodeById(rawTreeNodes.value, Number(selectedId) || 0)
  if (!selectedId || !selectionVisible || !isPlayablePlaylistNode(selectedNode)) {
    if (!flashArea.value) {
      flashBorder('selectSongList')
    }
    return
  }

  if (recentSelectedPlaylistIds.indexOf(selectedId) === -1) {
    recentSelectedPlaylistIds.unshift(selectedId)
  } else {
    recentSelectedPlaylistIds.unshift(
      recentSelectedPlaylistIds.splice(recentSelectedPlaylistIds.indexOf(selectedId), 1)[0]
    )
  }
  const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount ?? 10
  while (recentSelectedPlaylistIds.length > maxCount) {
    recentSelectedPlaylistIds.pop()
  }
  persistRecentDialogSelectedSongListUUIDs(RECENT_LIBRARY_KEY, recentSelectedPlaylistIds)

  closeWithAnimation(() => {
    props.confirmCallback({
      target: {
        mode: 'append',
        playlistId: Number(selectedId),
        playlistName: selectedNode?.name || ''
      }
    })
  })
}

const cancel = () => {
  if (dialogWriting.value) return
  closeWithAnimation(() => {
    props.cancelCallback()
  })
}

const handleSearchEnter = async () => {
  if (dialogWriting.value) return
  if (!normalizeKeyword(playlistSearch.value)) return
  const firstRecent = recentPlaylistArr.value.find((item) =>
    String(item.dirName || '')
      .toLowerCase()
      .includes(normalizeKeyword(playlistSearch.value))
  )
  const firstAll = allSongListArr.value.find((item) =>
    String(item.dirName || '')
      .toLowerCase()
      .includes(normalizeKeyword(playlistSearch.value))
  )
  if (!firstRecent && !firstAll) {
    await openCreatePlaylistDialog(0, String(playlistSearch.value || '').trim())
    searchInputRef.value?.blur()
    return
  }
  if (firstRecent) {
    runtime.dialogSelectedSongListUUID = firstRecent.uuid
    selectedArea.value = 'recent'
  } else if (firstAll) {
    runtime.dialogSelectedSongListUUID = firstAll.uuid
    selectedArea.value = 'tree'
  }
  syncNavIndexByUUID()
  searchInputRef.value?.blur()
}

watch(
  () => [
    visibleCombinedNavList.value.length,
    runtime.dialogSelectedSongListUUID,
    selectedArea.value
  ],
  () => {
    syncNavIndexByUUID()
  },
  { immediate: true }
)

watch(
  () => allSongListArr.value.length,
  (len) => {
    if (len > 0 && !runtime.dialogSelectedSongListUUID) {
      runtime.dialogSelectedSongListUUID = allSongListArr.value[0].uuid
      selectedArea.value = 'tree'
      syncNavIndexByUUID()
    }
  },
  { immediate: true }
)

watch(
  () => runtime.dialogSelectedSongListUUID,
  (val) => {
    if (!val) {
      selectedArea.value = ''
      navIndex.value = -1
      return
    }
    const inRecent = recentPlaylistArr.value.some((item) => item.uuid === val)
    const inTree = allSongListArr.value.some((item) => item.uuid === val)
    if (inRecent && inTree) {
      if (!selectedArea.value) selectedArea.value = 'recent'
    } else if (inRecent) {
      selectedArea.value = 'recent'
    } else if (inTree) {
      selectedArea.value = 'tree'
    } else {
      selectedArea.value = ''
    }
    syncNavIndexByUUID()
  }
)

watch(
  [
    () => runtime.dialogSelectedSongListUUID,
    () => selectedArea.value,
    () => recentPlaylistArr.value.length
  ],
  async () => {
    if (selectedArea.value === 'recent' && runtime.dialogSelectedSongListUUID) {
      await nextTick()
      try {
        recentRowRefs
          .get(runtime.dialogSelectedSongListUUID)
          ?.scrollIntoView?.({ block: 'nearest' })
      } catch {}
    }
  },
  { immediate: true }
)

onMounted(() => {
  hotkeys('s', uuid, () => {
    handleMoveDown()
  })
  hotkeys('w', uuid, () => {
    handleMoveUp()
  })
  hotkeys('down', uuid, (e) => {
    handleMoveDown(e)
  })
  hotkeys('up', uuid, (e) => {
    handleMoveUp(e)
  })
  hotkeys('E,Enter', uuid, () => {
    confirmHandle()
    return false
  })
  hotkeys('Esc', uuid, () => {
    cancel()
    return false
  })
  utils.setHotkeysScpoe(uuid)
  void loadTree()
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  runtime.dialogSelectedSongListUUID = ''
  runtime.selectSongListDialogShow = false
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div
      class="content inner"
      v-dialog-drag="'.dialog-title'"
      @contextmenu.stop.prevent="contextmenuEvent($event, 0)"
    >
      <div class="unselectable libraryTitle dialog-title dialog-header">
        <div class="collapseButtonPlaceholder"></div>
        <span>{{ props.dialogTitle }}</span>
        <div class="collapseButtonWrapper">
          <div style="display: flex; justify-content: center; align-items: center">
            <div
              ref="collapseButtonRef"
              class="collapseButton"
              data-dialog-drag-ignore="true"
              @click="collapseButtonHandleClick()"
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
            <bubbleBox
              :dom="collapseButtonRef || undefined"
              :title="t('playlist.collapsibleFolder')"
            />
          </div>
        </div>
      </div>

      <div class="dialog-body">
        <div class="librarySearchWrapper">
          <div class="searchRow">
            <div class="searchInputWrapper">
              <input
                ref="searchInputRef"
                v-model="playlistSearch"
                class="searchInput"
                :placeholder="t('playlist.searchPlaylists')"
                :disabled="dialogWriting"
                @keydown.down.prevent="handleMoveDown"
                @keydown.up.prevent="handleMoveUp"
                @keydown.enter.prevent.stop="handleSearchEnter"
              />
              <div
                v-show="String(playlistSearch || '').length"
                class="clearBtn"
                :class="{ clearBtnDisabled: dialogWriting }"
                @click="clearSearch()"
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
            <div
              v-if="showCreateNow"
              class="createNowBtn"
              :class="{ disabledAction: dialogWriting }"
              @click="createNow()"
            >
              {{ t('playlist.createNow') }}
            </div>
          </div>
        </div>

        <div
          v-if="allSongListArr.length > 0 || visibleTreeNodes.length > 0 || loading"
          class="unselectable libraryArea flashing-border"
          :class="{ 'is-flashing': flashArea === 'selectSongList' }"
        >
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
            <div class="sectionStack">
              <div v-if="recentPlaylistArr.length > 0" class="sectionCard sectionCard--recent">
                <div class="sectionHeader">
                  <div class="sectionTitle">
                    <span class="sectionAccent sectionAccent--recent"></span>
                    <span>{{ t('library.recentlyUsed') }}</span>
                  </div>
                </div>
                <div class="sectionBody">
                  <div
                    v-for="item of filteredRecentPlaylistArr"
                    :key="item.uuid"
                    :ref="(el) => setRecentRowRef(item.uuid, el)"
                    class="recentLibraryItem"
                    :class="{
                      selectedDir:
                        selectedArea === 'recent' &&
                        item.uuid === runtime.dialogSelectedSongListUUID
                    }"
                    @click="selectRecentPlaylist(item.uuid)"
                    @dblclick="confirmRecentPlaylist()"
                  >
                    <div
                      style="
                        width: 20px;
                        justify-content: center;
                        align-items: center;
                        display: flex;
                      "
                    >
                      <img class="songlist-icon" :src="listIconAsset" />
                    </div>
                    <div class="nameRow">
                      <span class="nameText">{{ item.dirName }}</span>
                    </div>
                  </div>
                  <div class="libraryDropSpace"></div>
                </div>
              </div>

              <div class="sectionCard sectionCard--all">
                <div class="sectionHeader">
                  <div class="sectionTitle">
                    <span class="sectionAccent sectionAccent--all"></span>
                    <span>{{ t('library.allPlaylists') }}</span>
                  </div>
                </div>
                <div class="sectionBody">
                  <template v-for="item of visibleTreeNodes" :key="`${item.id}`">
                    <RekordboxDesktopTargetTreeItem
                      :node="item"
                      :depth="0"
                      :expanded-ids="renderedExpandedFolderIds"
                      :selected-playlist-id="Number(runtime.dialogSelectedSongListUUID) || 0"
                      :interaction-disabled="dialogWriting"
                      :drag-target-node-id="dragTarget?.nodeId || null"
                      :drag-target-approach="dragTarget?.approach || ''"
                      :drag-source-id="dragSourceId"
                      @toggle-folder="toggleFolder"
                      @select-playlist="selectPlaylist"
                      @dbl-click-song-list="confirmHandle()"
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
                    v-if="loading || loadError || (!loading && !visibleTreeNodes.length)"
                    class="libraryEmptyHint"
                  >
                    <span v-if="loading">{{ t('rekordboxDesktop.loadingPlaylistTree') }}</span>
                    <span v-else-if="loadError">{{ loadError }}</span>
                    <span v-else>{{ t('rekordboxDesktop.emptyPlaylistTree') }}</span>
                  </div>
                  <div
                    v-if="!loading && visibleTreeNodes.length > 0"
                    class="libraryDropSpace"
                  ></div>
                </div>
              </div>
            </div>
          </OverlayScrollbarsComponent>
        </div>

        <div
          v-else
          class="unselectable flashing-border"
          :class="{ 'is-flashing': flashArea === 'selectSongList' }"
          style="
            max-width: 300px;
            display: flex;
            justify-content: center;
            align-items: center;
            flex-grow: 1;
            min-height: 0;
          "
        >
          <span style="font-size: 12px; color: var(--text-weak)">{{
            t('library.rightClickToCreate')
          }}</span>
        </div>
      </div>

      <div class="dialog-footer footer-centered">
        <div
          class="button dialogActionButton"
          :class="{ disabledAction: dialogWriting }"
          @click="confirmHandle()"
        >
          {{ t('rekordboxDesktop.confirmAction') }} (E)
        </div>
        <div
          class="button dialogActionButton"
          :class="{ disabledAction: dialogWriting }"
          @click="cancel()"
        >
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>

      <div v-if="dialogWriting" class="dialogBusyMask" data-dialog-drag-ignore="true">
        <div class="dialogBusyCard">
          <span class="dialogBusySpinner"></span>
          <span>{{ t('rekordboxDesktop.writingInProgress') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  position: relative;
}

.sectionStack {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px;
  box-sizing: border-box;
}

.sectionCard {
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px;
  box-sizing: border-box;
}

.sectionHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 6px 4px;
}

.sectionTitle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.sectionAccent {
  width: 6px;
  height: 14px;
  border-radius: 3px;
  background-color: var(--accent);
}

.sectionAccent--recent {
  background-color: var(--accent);
}

.sectionAccent--all {
  background-color: var(--text-weak);
}

.sectionBody {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0;
}

.libraryDropSpace {
  flex-grow: 1;
  min-height: 30px;
}

.recentLibraryItem {
  display: flex;
  height: 23px;
  align-items: center;
  font-size: 13px;
  border-radius: 4px;
  padding: 0 6px 0 2px;

  &:hover {
    background-color: var(--hover);
  }
}

.nameRow {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 8px;
  width: 100%;
  position: relative;
}

.nameText {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.songlist-icon {
  width: 13px;
  height: 13px;
}

.selectedDir {
  background-color: var(--hover);

  &:hover {
    background-color: var(--hover) !important;
  }
}

.libraryArea {
  max-width: 300px;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  flex-grow: 1;
  min-height: 0;
}

.content {
  height: 70vh;
  max-height: 70vh;
  width: 300px;
  max-width: 300px;
  display: flex;
  flex-grow: 1;
  background-color: var(--bg);
  overflow: hidden;
  flex-direction: column;

  .libraryTitle {
    padding: 0 12px 0 12px;
    font-size: 12px;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;

    span {
      flex: 1;
      text-align: center;
    }

    .collapseButtonPlaceholder,
    .collapseButtonWrapper {
      width: 32px;
      display: flex;
      justify-content: center;
      align-items: center;
      flex-shrink: 0;
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
}

.dialog-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background-color: var(--bg);
}

.footer-centered {
  justify-content: center;
}

.dialogActionButton {
  width: 90px;
  text-align: center;
}

.librarySearchWrapper {
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
}

.searchRow .searchInput {
  flex: 1 1 auto;
  width: 100%;
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
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  cursor: pointer;
  z-index: 1;
}

.clearBtnDisabled {
  pointer-events: none;
  opacity: 0.45;
}

.createNowBtn {
  height: 22px;
  line-height: 22px;
  padding: 0 8px;
  font-size: 12px;
  border-radius: 2px;
  border: 1px solid var(--border);
  box-sizing: border-box;
  background-color: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  flex-shrink: 0;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.disabledAction {
  pointer-events: none;
  opacity: 0.6;
}

.libraryEmptyHint {
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  font-size: 12px;
  text-align: center;
}

.dialogBusyMask {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(1px);
}

.dialogBusyCard {
  min-width: 150px;
  min-height: 44px;
  padding: 0 18px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  background: color-mix(in srgb, var(--bg-elev) 92%, var(--accent) 8%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text);
  font-size: 13px;
}

.dialogBusySpinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: rekordbox-dialog-busy-spin 0.8s linear infinite;
}

@keyframes rekordbox-dialog-busy-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
