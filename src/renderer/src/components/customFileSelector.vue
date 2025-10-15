<script setup lang="ts">
import {
  ref,
  computed,
  onMounted,
  onUnmounted,
  watch,
  nextTick,
  onBeforeUpdate,
  type PropType
} from 'vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import utils from '../utils/utils'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import audioFileIcon from '@renderer/assets/audioFile.png?asset'
import folderIcon from '@renderer/assets/folder.png?asset'
import desktopIcon from '@renderer/assets/desktop.png?asset'
import diskIcon from '@renderer/assets/disk.png?asset'

// 从设置中获取支持的音频文件扩展名
const getAudioExtensions = () => {
  const runtime = useRuntimeStore()
  return runtime.setting.audioExt || ['.mp3', '.wav', '.flac', '.aif', '.aiff']
}

// 路径记忆相关（长期保存，跨会话持久化）
const PATH_STORAGE_KEY = 'fileSelector_lastPath'
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
    // 忽略存储错误
  }
}

const clearSessionSelections = () => {
  try {
    sessionStorage.removeItem('importDialog_selectedPaths')
  } catch {
    // 忽略存储错误
  }
}

const findExistingPath = async (startPath: string): Promise<string> => {
  if (!startPath) return ''

  let currentPath = startPath
  const maxAttempts = 10 // 防止无限循环

  for (let i = 0; i < maxAttempts; i++) {
    try {
      // 尝试访问当前路径
      await window.electron.ipcRenderer.invoke('read-directory', currentPath)
      return currentPath // 路径存在，返回它
    } catch {
      // 路径不存在，尝试父目录
      const parentPath = currentPath.substring(
        0,
        currentPath.lastIndexOf('/') || currentPath.lastIndexOf('\\')
      )
      if (!parentPath || parentPath === currentPath) {
        break // 已经到达根目录
      }
      currentPath = parentPath
    }
  }

  return '' // 找不到有效路径
}

type FileSystemItem = {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: FileSystemItem[]
  isExpanded?: boolean
  isSelected?: boolean
  isVisible?: boolean
  parent?: FileSystemItem
}

type SelectedItem = {
  id: string
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
}

type SelectionModifiers = {
  shift: boolean
  ctrlOrMeta: boolean
}

const props = defineProps({
  visible: { type: Boolean, default: false },
  multiSelect: { type: Boolean, default: true },
  allowMixedSelection: { type: Boolean, default: true },
  initialSelectedPaths: { type: Array as PropType<string[]>, default: () => [] },
  onConfirm: { type: Function, required: true },
  onCancel: { type: Function, required: true }
})

const emit = defineEmits(['update:visible', 'confirm', 'cancel'])

const uuid = uuidV4()
const currentPath = ref('')
const fileTree = ref<FileSystemItem[]>([])
const selectedItems = ref<SelectedItem[]>([])
const searchQuery = ref('')
const isLoading = ref(false)
const expandedPaths = ref<Set<string>>(new Set())
const searchInputRef = ref<HTMLInputElement>()

// 当前选中的项目在文件树中的引用，用于快速更新
const selectedItemRefs = ref<Map<string, FileSystemItem>>(new Map())

const selectionModifiers = ref<SelectionModifiers>({ shift: false, ctrlOrMeta: false })

const updateSelectionModifiers = (event: KeyboardEvent | MouseEvent) => {
  selectionModifiers.value = {
    shift: !!event.shiftKey,
    ctrlOrMeta: !!(event.ctrlKey || (event as KeyboardEvent | undefined)?.metaKey)
  }
}

const clearSelectionModifiers = () => {
  selectionModifiers.value = { shift: false, ctrlOrMeta: false }
}

const DIRECTORY_CLICK_DELAY = 200
let directorySelectionTimer: ReturnType<typeof setTimeout> | null = null
let pendingDirectorySelection: {
  item: FileSystemItem
  modifiers: SelectionModifiers
} | null = null

const getModifiersFromEvent = (event?: MouseEvent | KeyboardEvent): SelectionModifiers => ({
  shift: !!event?.shiftKey,
  ctrlOrMeta: !!(event?.ctrlKey || (event as KeyboardEvent | undefined)?.metaKey)
})

const clearPendingDirectorySelection = () => {
  if (directorySelectionTimer) {
    clearTimeout(directorySelectionTimer)
    directorySelectionTimer = null
  }
  pendingDirectorySelection = null
}

const lastActiveIndex = ref<number | null>(null)
const anchorIndex = ref<number | null>(null)

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

const getFlatItems = () => filteredTree.value

const findItemIndex = (target: FileSystemItem) => {
  const items = getFlatItems()
  return items.findIndex((item) => item.path === target.path)
}

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

// 滚动条配置
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

const visible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value)
})

const filteredTree = computed(() => {
  const filterTree = (items: FileSystemItem[]): FileSystemItem[] => {
    return items.filter((item) => {
      // 搜索过滤
      if (searchQuery.value && !item.name.toLowerCase().includes(searchQuery.value.toLowerCase())) {
        return false
      }

      // 文件类型过滤
      if (item.type === 'file') {
        const ext = '.' + item.name.split('.').pop()?.toLowerCase()
        if (!getAudioExtensions().includes(ext)) {
          return false
        }
      }

      // 递归过滤子项
      if (item.children) {
        const filteredChildren = filterTree(item.children)
        item.children = filteredChildren
        return filteredChildren.length > 0 || item.type === 'directory'
      }

      return true
    })
  }

  // 对结果进行排序：文件夹在前，文件在后
  const sortItems = (items: FileSystemItem[]): FileSystemItem[] => {
    const folders = items.filter((item) => item.type === 'directory')
    const files = items.filter((item) => item.type === 'file')

    // 文件夹内部按名称排序，文件按名称排序
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

// 监听对话框显示状态
watch(
  () => props.visible,
  async (newVisible) => {
    if (newVisible) {
      await initialize()
      // 如果有初始选中的路径，标记它们为选中状态
      if (props.initialSelectedPaths.length > 0) {
        await markInitialSelections()
      } else {
        // 尝试从会话存储中恢复选中的项目
        await restoreSessionSelections()
      }
      await nextTick()
      searchInputRef.value?.focus()
    }
  }
)

// 初始化文件选择器
const initialize = async () => {
  isLoading.value = true
  try {
    // 首先尝试使用保存的路径（路径记忆）
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

    // 如果保存的路径不存在，显示驱动器列表
    await loadDrives()
  } catch (error) {
    console.error('初始化文件选择器失败:', error)
    // 回退到用户主目录
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

// 加载驱动器列表
const loadDrives = async () => {
  try {
    const drives = await window.electron.ipcRenderer.invoke('get-drives')

    // 获取用户桌面路径
    const userHome = await window.electron.ipcRenderer.invoke('get-user-home')
    const desktopPath = getDesktopPath(userHome)

    // 创建桌面快捷入口
    const desktopItem = {
      name: t('fileSelector.desktop'),
      path: desktopPath,
      type: 'directory' as const,
      size: 0,
      isExpanded: false,
      isSelected: false,
      isVisible: true,
      children: [],
      isSpecial: true // 标记为特殊项目
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

    // 将桌面选项放在驱动器列表的开头
    fileTree.value = [desktopItem, ...driveItems]
    currentPath.value = '' // 根级别
    saveLastUsedPath('') // 保存根级别路径
  } catch (error) {
    console.error('加载驱动器列表失败:', error)
    throw error
  }
}

// 获取桌面路径
const getDesktopPath = (userHome: string): string => {
  // 从 runtime store 获取平台信息
  const runtime = useRuntimeStore()
  const platform = runtime.setting.platform

  switch (platform) {
    case 'win32':
      return `${userHome}\\Desktop`
    case 'darwin':
      return `${userHome}/Desktop`
    default: // linux
      return `${userHome}/Desktop`
  }
}

// 标记初始选中的项目
const markInitialSelections = async () => {
  for (const selectedPath of props.initialSelectedPaths) {
    // 在文件树中找到对应的项目并标记为选中
    const markItemSelected = (items: FileSystemItem[]) => {
      for (const item of items) {
        if (item.path === selectedPath) {
          item.isSelected = true
          selectedItems.value.push({
            id: uuidV4(),
            name: item.name,
            path: item.path,
            type: item.type,
            size: item.size
          })
          selectedItemRefs.value.set(item.path, item)
          break
        }
        if (item.children) {
          markItemSelected(item.children)
        }
      }
    }
    markItemSelected(fileTree.value)
  }
}

// 从会话存储中恢复选中的项目
const restoreSessionSelections = async () => {
  try {
    const saved = sessionStorage.getItem('importDialog_selectedPaths')
    if (saved) {
      const selectedPaths = JSON.parse(saved)
      if (Array.isArray(selectedPaths) && selectedPaths.length > 0) {
        await markInitialSelections()
      }
    }
  } catch (error) {
    console.warn('恢复会话选中项目失败:', error)
  }
}

// 加载目录内容
const loadDirectory = async (dirPath: string) => {
  try {
    const items = await window.electron.ipcRenderer.invoke('read-directory', dirPath)

    // 构建树状结构
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

    // 回显：将已选中的路径映射到当前目录树
    if (selectedItems.value.length > 0) {
      const selectedPathSet = new Set(selectedItems.value.map((s) => s.path))
      for (const node of fileTree.value) {
        if (selectedPathSet.has(node.path)) {
          node.isSelected = true
          selectedItemRefs.value.set(node.path, node)
        }
      }
    }
  } catch (error) {
    console.error('加载目录失败:', error)
  }
}

const toggleDirectorySelectionState = (
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

// 处理项目点击（用于勾选）
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

// 处理项目双击（用于导航）
const handleItemDoubleClick = async (item: FileSystemItem, event?: MouseEvent) => {
  updateSelectionModifiers(event || ({} as KeyboardEvent))

  if (item.type !== 'directory') return

  clearPendingDirectorySelection()

  await navigateTo(item)
}

// 切换目录展开/折叠（双击时调用）
const toggleDirectory = async (item: FileSystemItem) => {
  if (item.type !== 'directory') return

  if (item.isExpanded) {
    item.isExpanded = false
    expandedPaths.value.delete(item.path)
  } else {
    if (item.children && item.children.length > 0) {
      item.isExpanded = true
      expandedPaths.value.add(item.path)
    } else {
      // 加载子目录内容
      try {
        const subItems = await window.electron.ipcRenderer.invoke('read-directory', item.path)
        if (Array.isArray(subItems)) {
          item.children = subItems.map((subItem: any) => ({
            name: subItem.name,
            path: subItem.path,
            type: subItem.isDirectory ? 'directory' : 'file',
            size: subItem.size,
            isExpanded: false,
            isSelected: false,
            isVisible: true,
            parent: item,
            children: subItem.isDirectory ? [] : undefined
          }))
          item.isExpanded = true
          expandedPaths.value.add(item.path)
        }
      } catch (error) {
        console.error('加载子目录失败:', error)
        // 可以在这里显示一个错误提示给用户
      }
    }
  }
}

// 选择/取消选择项目
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
      return // 不允许混合选择
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

  // 无修饰键：根据 multiSelect 决定是累加切换还是单选
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

// 清除所有选择
const clearSelection = () => {
  clearSelectionInternal()
  lastActiveIndex.value = null
  anchorIndex.value = null
}

// 导航到上级目录
const navigateUp = async () => {
  if (!currentPath.value) {
    // 已经在驱动器列表级别，重新加载驱动器
    await loadDrives()
    return
  }

  const pathParts = currentPath.value.split(/[/\\]/).filter(Boolean)
  if (pathParts.length > 0) {
    pathParts.pop()
    const parentPath = pathParts.join('/') || ''
    if (parentPath) {
      currentPath.value = parentPath
      saveLastUsedPath(parentPath) // 保存路径
      await loadDirectory(parentPath)
    } else {
      // 回到驱动器列表
      await loadDrives()
    }
  }
}

// 导航到指定目录
const navigateTo = async (item: FileSystemItem) => {
  if (item.type === 'directory') {
    currentPath.value = item.path
    saveLastUsedPath(item.path) // 保存路径
    await loadDirectory(item.path)
  }
}

// 格式化文件大小
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

// 判断项目是否为驱动器
const isDrive = (item: FileSystemItem) => {
  return item.name.includes(':') || (item as any).isSpecial
}

// 获取项目图标
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

// 确认选择
const confirm = () => {
  if (selectedItems.value.length === 0) return

  const result = selectedItems.value.map((item) => item.path)
  // 保存当前路径
  if (currentPath.value) {
    saveLastUsedPath(currentPath.value)
  }
  emit('confirm', result)
  close()
}

// 取消
const cancel = () => {
  emit('cancel')
  close()
}

// 关闭对话框
const close = () => {
  visible.value = false
  searchQuery.value = ''
  clearSelection()
  // 保存当前路径（如果有的话）
  if (currentPath.value) {
    saveLastUsedPath(currentPath.value)
  }
  // 清空会话级选中的项目
  clearSessionSelections()
}

const modalRef = ref<HTMLDivElement | null>(null)
const fileListRef = ref<HTMLElement | null>(null)
const selectedListRef = ref<HTMLElement | null>(null)

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
    case ' ': // Space
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
      toggleItemSelection(targetItem, { shift: false, ctrlOrMeta: event.ctrlKey || event.metaKey })
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

// 键盘快捷键
onMounted(() => {
  const modalEl = modalRef.value
  modalEl?.addEventListener('keydown', handleKeyDown)

  hotkeys('Escape', uuid, () => {
    cancel()
  })
  hotkeys('Enter', uuid, () => {
    if (selectedItems.value.length > 0) {
      confirm()
    }
  })
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  const modalEl = modalRef.value
  modalEl?.removeEventListener('keydown', handleKeyDown)
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div v-if="visible" class="file-selector-modal" ref="modalRef" tabindex="0">
    <div class="file-selector-content">
      <!-- 顶部路径导航 -->
      <div class="path-navigation">
        <div class="path-breadcrumb">
          <button class="back-button" type="button" @click="navigateUp" :disabled="!currentPath">
            {{ t('fileSelector.navigateUp') }}
          </button>
          <span class="path-current" :title="currentPath" v-if="currentPath">{{
            currentPath
          }}</span>
          <span class="path-current" v-else>{{ t('fileSelector.rootLabel') }}</span>
        </div>
        <div class="path-search">
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            type="text"
            :placeholder="t('fileSelector.searchPlaceholder')"
            class="search-input"
          />
        </div>
      </div>

      <!-- 主要内容区域 -->
      <div class="main-content">
        <!-- 文件列表 -->
        <div class="file-list-container">
          <div class="file-list-header">
            <span class="header-name">{{ t('fileSelector.name') }}</span>
            <span class="header-size">{{ t('fileSelector.size') }}</span>
            <span class="header-type">{{ t('fileSelector.type') }}</span>
          </div>

          <div v-if="isLoading" class="loading-state">
            <div class="loading-spinner"></div>
            <span>{{ t('fileSelector.loading') }}</span>
          </div>

          <OverlayScrollbarsComponent
            v-else
            :options="scrollbarOptions"
            element="div"
            class="file-list"
            defer
          >
            <div v-for="(item, index) in filteredTree" :key="item.path" class="file-item-wrapper">
              <div
                class="file-item"
                :class="{
                  'is-directory': item.type === 'directory',
                  'is-file': item.type === 'file',
                  'is-selected': item.isSelected
                }"
                :data-index="findItemIndex(item)"
                :data-path="item.path"
                @click="handleItemClick(item, $event)"
                @dblclick="item.type === 'directory' ? handleItemDoubleClick(item, $event) : null"
              >
                <div class="item-icon">
                  <img :src="getItemIcon(item)" alt="" />
                </div>
                <div class="item-name-wrapper">
                  <div class="item-name" :title="item.name">{{ item.name }}</div>
                </div>
                <div class="item-size" v-if="item.size && item.size > 0">
                  {{ formatFileSize(item.size) }}
                </div>
                <div class="item-size" v-else-if="item.type === 'directory'">-</div>
                <div class="item-size" v-else>{{ formatFileSize(item.size || 0) }}</div>
                <div class="item-type" v-if="item.type === 'file'">
                  {{ item.name.split('.').pop()?.toUpperCase() }}
                </div>
                <div class="item-type" v-else-if="item.type === 'directory'">
                  {{
                    (item as any).isSpecial
                      ? '常用文件夹'
                      : isDrive(item)
                        ? '驱动器'
                        : t('fileSelector.folder')
                  }}
                </div>
              </div>
            </div>
          </OverlayScrollbarsComponent>
        </div>

        <!-- 选中项目面板 -->
        <div class="selected-panel">
          <div class="selected-header">
            <h4 class="selected-title">
              {{ t('fileSelector.selectedItems') }}
              <span class="selected-count">({{ selectedCount }})</span>
            </h4>
            <button @click="clearSelection" class="clear-btn" :disabled="selectedCount === 0">
              {{ t('fileSelector.clearAll') }}
            </button>
          </div>

          <div class="selected-stats">
            <span v-if="selectedFilesCount > 0" class="stat-item">
              {{ t('fileSelector.filesSelected', { count: selectedFilesCount }) }}
            </span>
            <span v-if="selectedFoldersCount > 0" class="stat-item">
              {{ t('fileSelector.foldersSelected', { count: selectedFoldersCount }) }}
            </span>
          </div>

          <OverlayScrollbarsComponent
            v-if="selectedCount > 0"
            :options="scrollbarOptions"
            element="div"
            class="selected-list"
            ref="selectedListRef"
            defer
          >
            <div v-for="item in selectedItems" :key="item.id" class="selected-item">
              <div class="selected-icon">
                <img :src="getItemIcon(item as any)" alt="" />
              </div>
              <div class="selected-info">
                <div class="selected-name" :title="item.name">{{ item.name }}</div>
                <div class="selected-path" :title="item.path">{{ item.path }}</div>
              </div>
              <button @click="removeSelectionByPath(item.path)" class="remove-btn">×</button>
            </div>
          </OverlayScrollbarsComponent>

          <div v-else class="empty-selection">
            {{ t('fileSelector.noSelection') }}
          </div>
        </div>
      </div>

      <!-- 底部操作区 -->
      <div class="action-bar">
        <div class="action-buttons">
          <button @click="cancel" class="cancel-btn">{{ t('common.cancel') }}</button>
          <button @click="confirm" :disabled="selectedItems.length === 0" class="confirm-btn">
            {{ t('fileSelector.selectItems', { count: selectedCount }) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.file-selector-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 700px;
  height: 450px;
  background: #181818;
  border: 1px solid #424242;
  border-radius: 6px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  z-index: 1000;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  user-select: none;
  -webkit-user-select: none;
}

.file-selector-content {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* 路径导航 */
.path-navigation {
  padding: 10px 12px;
  background: #202020;
  border-bottom: 1px solid #424242;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;

  .path-breadcrumb {
    display: flex;
    align-items: center;
    flex: 1;
    font-size: 12px;
    color: #cccccc;
    gap: 8px;

    .back-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 4px 8px;
      border: 1px solid #424242;
      border-radius: 4px;
      background: #2a2a2a;
      color: #cccccc;
      font-size: 12px;
      cursor: pointer;
      transition:
        background-color 0.2s,
        border-color 0.2s;
      min-width: 80px;

      &:hover:not(:disabled) {
        background: #333333;
        border-color: #4a9eff;
        color: #ffffff;
      }

      &:disabled {
        cursor: not-allowed;
        background: #1f1f1f;
        color: #555555;
        border-color: #333333;
      }
    }

    .path-current {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .path-search {
    .search-input {
      width: 160px;
      height: 25px;
      padding: 0 8px;
      border: 1px solid #424242;
      border-radius: 4px;
      font-size: 12px;
      background: #2a2a2a;
      color: #cccccc;

      &:focus {
        outline: none;
        border-color: #0078d4;
        box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
      }

      &::placeholder {
        color: #666666;
      }
    }
  }
}

/* 主要内容区域 */
.main-content {
  flex: 1;
  display: flex;
  min-height: 0;
  height: 100%;
}

/* 文件列表 */
.file-list-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #181818;
  min-width: 0; /* 防止flex项目溢出 */
  width: 0; /* 确保flex项目占用剩余空间 */

  .file-list-header {
    display: flex;
    padding: 6px 12px;
    background: #1a1a1a;
    border-bottom: 1px solid #424242;
    font-size: 11px;
    font-weight: 500;
    color: #999999;
    text-transform: uppercase;

    span {
      flex: 1;
      min-width: 0;

      &:first-child {
        flex: 1;
        min-width: 200px; // 文件名列最小宽度
      }

      &:nth-child(2) {
        flex: 0 0 80px;
        text-align: right;
        min-width: 80px;
      }

      &:nth-child(3) {
        flex: 0 0 80px;
        text-align: right;
        min-width: 80px;
      }
    }
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: #999999;
    font-size: 14px;

    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid #2d2e2e;
      border-top: 3px solid #4a9eff;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 12px;
    }
  }

  .file-list {
    flex: 1;
    height: 100%;
    padding: 2px 0;
    overflow: hidden;

    .file-item-wrapper {
      width: 100%;
    }

    .file-item {
      display: flex;
      align-items: center;
      padding: 4px 12px;
      cursor: default;
      border-bottom: 1px solid #1a1a1a;
      transition: background-color 0.2s;

      &:hover {
        background-color: #202020;
      }

      &.is-selected {
        background-color: #1e3a5f;
        border-color: #0078d4;
      }

      .item-icon {
        flex: 0 0 18px;
        text-align: center;
        margin-right: 8px;
        font-size: 14px;

        img {
          width: 18px;
          height: 18px;
          object-fit: contain;
          display: block;
          filter: brightness(0.85);
        }
      }

      .item-name-wrapper {
        flex: 1;
        min-width: 200px;
        max-width: 300px;
        margin-right: 8px;
      }

      .item-name {
        font-size: 12px;
        color: #cccccc;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .item-size {
        flex: 0 0 80px;
        text-align: right;
        font-size: 11px;
        color: #999999;
        min-width: 80px;
      }

      .item-type {
        flex: 0 0 80px;
        text-align: right;
        font-size: 10px;
        color: #999999;
        text-transform: uppercase;
        min-width: 80px;
      }
    }
  }
}

/* 选中项目面板 */
.selected-panel {
  width: 200px;
  background: #1a1a1a;
  border-left: 1px solid #424242;
  display: flex;
  flex-direction: column;

  .selected-header {
    padding: 8px 10px;
    border-bottom: 1px solid #424242;
    display: flex;
    justify-content: space-between;
    align-items: center;

    .selected-title {
      font-size: 12px;
      font-weight: 600;
      color: #cccccc;
      margin: 0;

      .selected-count {
        color: #0078d4;
        font-weight: normal;
      }
    }

    .clear-btn {
      height: 20px;
      line-height: 20px;
      padding: 0 8px;
      border-radius: 4px;
      background-color: #dc3545;
      color: #ffffff;
      border: none;
      font-size: 11px;
      cursor: pointer;
      transition: background-color 0.2s;

      &:hover:not(:disabled) {
        background: #c82333;
      }

      &:disabled {
        background: #666666;
        cursor: not-allowed;
      }
    }
  }

  .selected-stats {
    padding: 6px 10px;
    background: #202020;
    font-size: 11px;
    color: #999999;

    .stat-item {
      display: inline-block;
      margin-right: 8px;

      &:last-child {
        margin-right: 0;
      }
    }
  }

  .selected-list {
    flex: 1;
    height: 100%;
    padding: 6px;
    overflow: hidden;

    .selected-item {
      display: flex;
      align-items: center;
      padding: 4px 6px;
      margin-bottom: 3px;
      background: #2a2a2a;
      border: 1px solid #333333;
      border-radius: 3px;
      cursor: default;
      gap: 4px;

      .selected-icon {
        flex: 0 0 16px;
        text-align: center;
        margin-right: 6px;
        font-size: 12px;

        img {
          width: 16px;
          height: 16px;
          object-fit: contain;
          display: block;
          filter: brightness(0.85);
        }
      }

      .selected-info {
        flex: 1;
        min-width: 0;

        .selected-name {
          font-size: 11px;
          font-weight: 500;
          color: #cccccc;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .selected-path {
          font-size: 9px;
          color: #999999;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }

      .remove-btn {
        flex: 0 0 auto;
        background: none;
        border: none;
        color: #dc3545;
        cursor: pointer;
        font-size: 12px;
        padding: 0;
        width: 16px;
        height: 16px;
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;

        &:hover {
          color: #ff6b81;
        }
      }
    }
  }

  .empty-selection {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #999999;
    font-size: 12px;
    font-style: italic;
  }
}

/* 操作栏 */
.action-bar {
  padding: 8px 12px;
  background: #202020;
  border-top: 1px solid #424242;
  display: flex;
  justify-content: center;
  align-items: center;

  .action-buttons {
    display: flex;
    gap: 8px;

    .cancel-btn {
      height: 25px;
      line-height: 25px;
      padding: 0 10px;
      border-radius: 5px;
      background-color: #2d2e2e;
      color: #cccccc;
      border: none;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;

      &:hover {
        color: white;
        background-color: #0078d4;
      }
    }

    .confirm-btn {
      height: 25px;
      line-height: 25px;
      padding: 0 10px;
      border-radius: 5px;
      background-color: #2d2e2e;
      color: #cccccc;
      border: none;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;

      &:hover:not(:disabled) {
        color: white;
        background-color: #0078d4;
      }

      &:disabled {
        background: #666666;
        cursor: not-allowed;
        color: #999999;
      }
    }
  }
}

/* 动画 */
@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
</style>
