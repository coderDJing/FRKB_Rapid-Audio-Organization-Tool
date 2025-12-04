import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import utils from '@renderer/utils/utils'
import audioFileIcon from '@renderer/assets/audioFile.png?asset'
import folderIcon from '@renderer/assets/folder.png?asset'
import desktopIcon from '@renderer/assets/desktop.png?asset'
import diskIcon from '@renderer/assets/disk.png?asset'
import type {
  CustomFileSelectorEmits,
  CustomFileSelectorProps,
  FileSystemItem,
  SelectedItem,
  SelectionModifiers
} from './types'

const PATH_STORAGE_KEY = 'fileSelector_lastPath'
const DIRECTORY_CLICK_DELAY = 200
const scrollbarOptions = {
  scrollbars: {
    autoHide: 'leave' as const,
    autoHideDelay: 50,
    clickScroll: true
  } as const,
  overflow: {
    x: 'hidden',
    y: 'scroll'
  } as const
}

const getAudioExtensions = () => {
  const runtime = useRuntimeStore()
  return (
    runtime.setting.audioExt || [
      '.mp3',
      '.wav',
      '.flac',
      '.aif',
      '.aiff',
      '.ogg',
      '.opus',
      '.aac',
      '.m4a',
      '.mp4',
      '.wma',
      '.ac3',
      '.dts',
      '.mka',
      '.webm',
      '.ape',
      '.tak',
      '.tta',
      '.wv'
    ]
  )
}

const getLastUsedPath = (): string => {
  try {
    return localStorage.getItem(PATH_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

const saveLastUsedPath = (path: string) => {
  try {
    localStorage.setItem(PATH_STORAGE_KEY, path)
  } catch {
    // ignore
  }
}

const findExistingPath = async (startPath: string): Promise<string> => {
  if (!startPath) return ''

  let currentPath = startPath
  const maxAttempts = 10

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await window.electron.ipcRenderer.invoke('read-directory', currentPath)
      return currentPath
    } catch {
      const parentPath = currentPath.substring(
        0,
        currentPath.lastIndexOf('/') || currentPath.lastIndexOf('\\')
      )
      if (!parentPath || parentPath === currentPath) {
        break
      }
      currentPath = parentPath
    }
  }

  return ''
}

export function useCustomFileSelector(
  props: CustomFileSelectorProps,
  emit: CustomFileSelectorEmits
) {
  const uuid = uuidV4()
  const currentPath = ref('')
  const fileTree = ref<FileSystemItem[]>([])
  const selectedItems = ref<SelectedItem[]>([])
  const searchQuery = ref('')
  const isLoading = ref(false)
  const expandedPaths = ref<Set<string>>(new Set())
  const searchInputRef = ref<HTMLInputElement>()
  const selectedItemRefs = ref<Map<string, FileSystemItem>>(new Map())
  const selectionModifiers = ref<SelectionModifiers>({ shift: false, ctrlOrMeta: false })
  const lastActiveIndex = ref<number | null>(null)
  const anchorIndex = ref<number | null>(null)
  const modalRef = ref<HTMLDivElement | null>(null)
  const fileListRef = ref<HTMLElement | null>(null)
  const selectedListRef = ref<HTMLElement | null>(null)

  let directorySelectionTimer: ReturnType<typeof setTimeout> | null = null
  let pendingDirectorySelection: {
    item: FileSystemItem
    modifiers: SelectionModifiers
  } | null = null

  const updateSelectionModifiers = (event: KeyboardEvent | MouseEvent) => {
    selectionModifiers.value = {
      shift: !!event.shiftKey,
      ctrlOrMeta: !!(event.ctrlKey || (event as KeyboardEvent | undefined)?.metaKey)
    }
  }

  const clearSelectionModifiers = () => {
    selectionModifiers.value = { shift: false, ctrlOrMeta: false }
  }

  const getFlatItems = () => filteredTree.value

  const findItemIndex = (target: FileSystemItem) => {
    const items = getFlatItems()
    return items.findIndex((item) => item.path === target.path)
  }

  const setActiveIndexAndFocus = (index: number) => {
    lastActiveIndex.value = index
    anchorIndex.value = index

    nextTick(() => {
      adjustScrollToItem(index)
    })
  }

  const adjustScrollToItem = (index: number) => {
    const container = fileListRef.value
    if (!container) return
    const item = container.querySelector<HTMLElement>(`.file-item[data-index="${index}"]`)
    if (item) {
      item.scrollIntoView({ block: 'nearest' })
    }
  }

  const createSelectedItem = (item: FileSystemItem): SelectedItem => ({
    id: uuidV4(),
    name: item.name,
    path: item.path,
    type: item.type,
    size: item.size
  })

  const addSelection = (item: FileSystemItem, options?: { skipRange?: boolean }) => {
    if (selectedItems.value.some((selected) => selected.path === item.path)) return

    selectedItems.value.push(createSelectedItem(item))
    selectedItemRefs.value.set(item.path, item)
    item.isSelected = true

    if (!options?.skipRange) {
      setActiveIndexAndFocus(findItemIndex(item))
    }
  }

  const removeSelectionInternal = (path: string, options?: { skipRange?: boolean }) => {
    const existingIndex = selectedItems.value.findIndex((selected) => selected.path === path)
    if (existingIndex === -1) return

    selectedItems.value.splice(existingIndex, 1)

    const treeItem = selectedItemRefs.value.get(path)
    if (treeItem) {
      treeItem.isSelected = false
    }
    selectedItemRefs.value.delete(path)

    if (!options?.skipRange) {
      if (selectedItems.value.length === 0) {
        lastActiveIndex.value = null
        anchorIndex.value = null
        return
      }

      const fallbackPath = selectedItems.value[selectedItems.value.length - 1]?.path
      if (fallbackPath) {
        const fallbackItem = selectedItemRefs.value.get(fallbackPath)
        if (fallbackItem) {
          const idx = findItemIndex(fallbackItem)
          if (idx >= 0) {
            lastActiveIndex.value = idx
            anchorIndex.value = idx
            adjustScrollToItem(idx)
            return
          }
        }
      }

      lastActiveIndex.value = null
      anchorIndex.value = null
    }
  }

  const removeSelectionByPath = (path: string) => removeSelectionInternal(path)

  const clearSelectionInternal = () => {
    selectedItems.value.forEach((item) => {
      const treeItem = selectedItemRefs.value.get(item.path)
      if (treeItem) {
        treeItem.isSelected = false
      }
    })
    selectedItems.value = []
    selectedItemRefs.value.clear()
  }

  const clearSelection = () => {
    clearSelectionInternal()
    lastActiveIndex.value = null
    anchorIndex.value = null
  }

  const visible = computed({
    get: () => props.visible,
    set: (value) => emit('update:visible', value)
  })

  const filteredTree = computed(() => {
    const filterTree = (items: FileSystemItem[]): FileSystemItem[] => {
      return items.filter((item) => {
        if (
          searchQuery.value &&
          !item.name.toLowerCase().includes(searchQuery.value.toLowerCase())
        ) {
          return false
        }

        if (item.type === 'file') {
          const ext = '.' + item.name.split('.').pop()?.toLowerCase()
          if (!getAudioExtensions().includes(ext)) {
            return false
          }
        }

        if (item.children) {
          const filteredChildren = filterTree(item.children)
          item.children = filteredChildren
          return filteredChildren.length > 0 || item.type === 'directory'
        }

        return true
      })
    }

    const sortItems = (items: FileSystemItem[]): FileSystemItem[] => {
      const folders = items.filter((item) => item.type === 'directory')
      const files = items.filter((item) => item.type === 'file')
      folders.sort((a, b) => a.name.localeCompare(b.name))
      files.sort((a, b) => a.name.localeCompare(b.name))
      return [...folders, ...files]
    }

    const filtered = filterTree([...fileTree.value])
    return sortItems(filtered)
  })

  const selectedCount = computed(() => selectedItems.value.length)
  const selectedFilesCount = computed(
    () => selectedItems.value.filter((item) => item.type === 'file').length
  )
  const selectedFoldersCount = computed(
    () => selectedItems.value.filter((item) => item.type === 'directory').length
  )

  const clearPendingDirectorySelection = () => {
    if (directorySelectionTimer) {
      clearTimeout(directorySelectionTimer)
      directorySelectionTimer = null
    }
    pendingDirectorySelection = null
  }

  const toggleSelectionForItem = (
    item: FileSystemItem,
    select: boolean,
    options?: { skipRange?: boolean }
  ) => {
    if (select) {
      addSelection(item, options)
    } else {
      removeSelectionInternal(item.path, options)
    }
  }

  const toggleItemSelection = (
    item: FileSystemItem,
    modifiers: SelectionModifiers = selectionModifiers.value
  ) => {
    const items = getFlatItems()
    const currentIndex = findItemIndex(item)
    if (currentIndex === -1) return

    if (!props.allowMixedSelection && selectedItems.value.length > 0) {
      const firstType = selectedItems.value[0].type
      if (firstType !== item.type) {
        return
      }
    }

    if (modifiers.shift && anchorIndex.value !== null) {
      const start = Math.min(anchorIndex.value, currentIndex)
      const end = Math.max(anchorIndex.value, currentIndex)

      clearSelectionInternal()

      for (let i = start; i <= end; i++) {
        const rangeItem = items[i]
        toggleSelectionForItem(rangeItem, true, { skipRange: true })
      }

      setActiveIndexAndFocus(currentIndex)
      return
    }

    if (modifiers.ctrlOrMeta) {
      if (item.isSelected) {
        removeSelectionInternal(item.path)
      } else {
        addSelection(item)
      }
      anchorIndex.value = findItemIndex(item)
      lastActiveIndex.value = anchorIndex.value
      return
    }

    if (props.multiSelect) {
      if (item.isSelected) {
        removeSelectionInternal(item.path)
      } else {
        addSelection(item)
      }
      anchorIndex.value = currentIndex
      lastActiveIndex.value = currentIndex
    } else {
      clearSelectionInternal()
      addSelection(item)
      setActiveIndexAndFocus(currentIndex)
    }
  }

  const handleItemClick = (item: FileSystemItem, event?: MouseEvent) => {
    if (event) {
      updateSelectionModifiers(event)
    } else {
      clearSelectionModifiers()
    }

    if (event && event.button !== 0) {
      return
    }

    const modifiers = selectionModifiers.value

    if (item.type === 'directory') {
      clearPendingDirectorySelection()
      pendingDirectorySelection = { item, modifiers }
      directorySelectionTimer = setTimeout(() => {
        if (pendingDirectorySelection?.item === item) {
          toggleItemSelection(item, modifiers)
        }
        clearPendingDirectorySelection()
      }, DIRECTORY_CLICK_DELAY)
      return
    }

    toggleItemSelection(item, modifiers)
  }

  const navigateTo = async (item: FileSystemItem) => {
    if (item.type === 'directory') {
      currentPath.value = item.path
      saveLastUsedPath(item.path)
      await loadDirectory(item.path)
    }
  }

  const handleItemDoubleClick = async (item: FileSystemItem, event?: MouseEvent) => {
    updateSelectionModifiers(event || ({} as KeyboardEvent))

    if (item.type !== 'directory') return

    clearPendingDirectorySelection()
    await navigateTo(item)
  }

  const loadDirectory = async (dirPath: string) => {
    try {
      const items = await window.electron.ipcRenderer.invoke('read-directory', dirPath)

      const treeItems: FileSystemItem[] = items.map((item: any) => ({
        name: item.name,
        path: item.path,
        type: item.isDirectory ? 'directory' : 'file',
        size: item.size,
        isExpanded: false,
        isSelected: false,
        isVisible: true,
        children: item.isDirectory ? [] : undefined
      }))

      fileTree.value = treeItems
      expandedPaths.value.add(dirPath)

      if (selectedItems.value.length > 0) {
        const selectedPathSet = new Set(selectedItems.value.map((s) => s.path))
        const mapTree = (nodes: FileSystemItem[]) => {
          for (const node of nodes) {
            if (selectedPathSet.has(node.path)) {
              node.isSelected = true
              selectedItemRefs.value.set(node.path, node)
            }
            if (node.children && node.children.length > 0) {
              mapTree(node.children)
            }
          }
        }
        mapTree(fileTree.value)
      }
    } catch (error) {
      console.error('加载目录失败:', error)
    }
  }

  const getDesktopPath = (userHome: string): string => {
    const runtime = useRuntimeStore()
    const platform = runtime.setting.platform

    switch (platform) {
      case 'win32':
        return `${userHome}\\Desktop`
      case 'darwin':
        return `${userHome}/Desktop`
      default:
        return `${userHome}/Desktop`
    }
  }

  const loadDrives = async () => {
    try {
      const drives = await window.electron.ipcRenderer.invoke('get-drives')
      const userHome = await window.electron.ipcRenderer.invoke('get-user-home')
      const desktopPath = getDesktopPath(userHome)

      const desktopItem = {
        name: t('fileSelector.desktop'),
        path: desktopPath,
        type: 'directory' as const,
        size: 0,
        isExpanded: false,
        isSelected: false,
        isVisible: true,
        children: [],
        isSpecial: true
      }

      const driveItems = drives.map((drive: any) => ({
        name: drive.name,
        path: drive.path,
        type: 'directory' as const,
        size: drive.size || 0,
        isExpanded: false,
        isSelected: false,
        isVisible: true,
        children: []
      }))

      fileTree.value = [desktopItem, ...driveItems]
      currentPath.value = ''
    } catch (error) {
      console.error('加载驱动器列表失败:', error)
      throw error
    }
  }

  const markInitialSelections = async () => {
    const ensureSelectedItem = (path: string) => {
      const exists = selectedItems.value.some((s) => s.path === path)
      if (!exists) {
        const parts = path.split(/[/\\]/)
        const name = parts[parts.length - 1] || path
        selectedItems.value.push({
          id: uuidV4(),
          name,
          path,
          type: 'file',
          size: 0
        })
      }
    }

    const tryMarkOnTree = (path: string) => {
      const dfs = (items: FileSystemItem[]) => {
        for (const item of items) {
          if (item.path === path) {
            item.isSelected = true
            selectedItemRefs.value.set(item.path, item)
            return true
          }
          if (item.children && dfs(item.children)) return true
        }
        return false
      }
      dfs(fileTree.value)
    }

    for (const p of props.initialSelectedPaths) {
      ensureSelectedItem(p)
      tryMarkOnTree(p)
    }
  }

  const initialize = async () => {
    isLoading.value = true
    try {
      const lastPath = getLastUsedPath()
      if (lastPath) {
        try {
          const existingPath = await findExistingPath(lastPath)
          if (existingPath) {
            currentPath.value = existingPath
            await loadDirectory(existingPath)
            return
          }
        } catch (error) {
          console.warn('使用保存的路径失败:', error)
        }
      }

      await loadDrives()
    } catch (error) {
      console.error('初始化文件选择器失败:', error)
      try {
        const userHome = await window.electron.ipcRenderer.invoke('get-user-home')
        currentPath.value = userHome
        await loadDirectory(userHome)
      } catch (fallbackError) {
        console.error('回退到用户目录失败:', fallbackError)
      }
    } finally {
      isLoading.value = false
    }
  }

  const navigateUp = async () => {
    if (!currentPath.value) {
      await loadDrives()
      return
    }

    const pathParts = currentPath.value.split(/[/\\]/).filter(Boolean)
    if (pathParts.length > 0) {
      pathParts.pop()
      const parentPath = pathParts.join('/') || ''
      if (parentPath) {
        currentPath.value = parentPath
        saveLastUsedPath(parentPath)
        await loadDirectory(parentPath)
      } else {
        await loadDrives()
      }
    }
  }

  const formatFileSize = (bytes: number) => {
    const units = ['B', 'KB', 'MB', 'GB']
    let size = bytes
    let unitIndex = 0

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024
      unitIndex++
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`
  }

  const isDrive = (item: FileSystemItem) => {
    return item.name.includes(':') || (item as any).isSpecial
  }

  const getItemIcon = (item: FileSystemItem) => {
    if ((item as any).isSpecial) {
      return desktopIcon
    }

    if (item.type === 'directory') {
      if (isDrive(item)) {
        return diskIcon
      }
      return folderIcon
    }

    const ext = '.' + item.name.split('.').pop()?.toLowerCase()
    if (getAudioExtensions().includes(ext)) {
      return audioFileIcon
    }

    return audioFileIcon
  }

  const confirm = () => {
    const result = selectedItems.value.map((item) => item.path)
    emit('confirm', result)
    close()
  }

  const cancel = () => {
    emit('cancel')
    close()
  }

  const close = () => {
    visible.value = false
    searchQuery.value = ''
    clearSelection()
    if (currentPath.value) {
      saveLastUsedPath(currentPath.value)
    }
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    updateSelectionModifiers(event)
    const items = getFlatItems()
    if (items.length === 0) return

    const currentIndex =
      lastActiveIndex.value ??
      (selectedItems.value.length > 0
        ? findItemIndex(
            selectedItems.value[selectedItems.value.length - 1] as unknown as FileSystemItem
          )
        : 0)

    let newIndex = currentIndex

    switch (event.key) {
      case 'ArrowUp':
        newIndex = Math.max(0, currentIndex - 1)
        event.preventDefault()
        break
      case 'ArrowDown':
        newIndex = Math.min(items.length - 1, currentIndex + 1)
        event.preventDefault()
        break
      case 'PageUp':
        newIndex = Math.max(0, currentIndex - 10)
        event.preventDefault()
        break
      case 'PageDown':
        newIndex = Math.min(items.length - 1, currentIndex + 10)
        event.preventDefault()
        break
      case 'Home':
        newIndex = 0
        event.preventDefault()
        break
      case 'End':
        newIndex = items.length - 1
        event.preventDefault()
        break
      case 'a':
        if (event.ctrlKey || event.metaKey) {
          clearSelectionInternal()
          items.forEach((item) => toggleSelectionForItem(item, true, { skipRange: true }))
          event.preventDefault()
          lastActiveIndex.value = items.length - 1
        }
        return
      case 'Escape':
        clearSelection()
        return
      case ' ':
        if (items[currentIndex]) {
          toggleSelectionForItem(items[currentIndex], !items[currentIndex].isSelected)
          event.preventDefault()
        }
        return
      default:
        return
    }

    if (items[newIndex]) {
      const targetItem = items[newIndex]
      if (event.shiftKey && lastActiveIndex.value !== null) {
        toggleItemSelection(targetItem, { shift: true, ctrlOrMeta: event.ctrlKey || event.metaKey })
      } else {
        toggleItemSelection(targetItem, {
          shift: false,
          ctrlOrMeta: event.ctrlKey || event.metaKey
        })
      }

      nextTick(() => {
        const container = fileListRef.value
        const itemEl = container?.querySelector<HTMLElement>(
          `.file-item[data-path="${CSS.escape(targetItem.path)}"]`
        )
        if (itemEl) {
          itemEl.scrollIntoView({ block: 'nearest' })
        }
      })
    }
  }

  watch(
    () => props.visible,
    async (newVisible) => {
      if (newVisible) {
        await initialize()
        if (props.initialSelectedPaths.length > 0) {
          await markInitialSelections()
        }
      }
    }
  )

  onMounted(() => {
    const modalEl = modalRef.value
    modalEl?.addEventListener('keydown', handleKeyDown)

    hotkeys('Esc', uuid, () => {
      cancel()
    })
    hotkeys('E,Enter', uuid, () => {
      confirm()
    })
    utils.setHotkeysScpoe(uuid)
  })

  onUnmounted(() => {
    const modalEl = modalRef.value
    modalEl?.removeEventListener('keydown', handleKeyDown)
    utils.delHotkeysScope(uuid)
  })

  return {
    visible,
    currentPath,
    fileTree,
    selectedItems,
    searchQuery,
    isLoading,
    searchInputRef,
    filteredTree,
    selectedCount,
    selectedFilesCount,
    selectedFoldersCount,
    scrollbarOptions,
    handleItemClick,
    handleItemDoubleClick,
    removeSelectionByPath,
    clearSelection,
    confirm,
    cancel,
    modalRef,
    fileListRef,
    selectedListRef,
    formatFileSize,
    getItemIcon,
    navigateUp,
    findItemIndex,
    isDrive
  }
}
