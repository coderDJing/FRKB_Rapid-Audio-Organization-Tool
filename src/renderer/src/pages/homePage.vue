<script setup lang="ts">
import librarySelectArea from './modules/librarySelectArea.vue'
import libraryArea from './modules/libraryArea.vue'
import songsArea from './modules/songsArea/songsArea.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { onMounted, onUnmounted, ref, computed, watch } from 'vue'
import songPlayer from './modules/songPlayer/songPlayer.vue'
import dropIntoDialog from '../components/dropIntoDialog'
import { Icon } from '../../../types/globals'
import libraryUtils from '@renderer/utils/libraryUtils'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { appendExternalPlaylistFromPaths } from '@renderer/utils/externalPlaylist'
import { EXTERNAL_PLAYLIST_UUID } from '@shared/externalPlayback'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
const runtime = useRuntimeStore()
let startX = 0
let isResizing = false
const isHovered = ref(false)
let hoverTimeout: NodeJS.Timeout
const librarySwitching = ref(false)
let librarySwitchTimer: ReturnType<typeof setTimeout> | null = null

// 计算 dragBar 的 left 样式
const dragBarLeft = computed(() => {
  return runtime.layoutConfig.libraryAreaWidth + 'px'
})

const handleMouseEnter = () => {
  // 清除之前的定时器，以防用户频繁移动鼠标进出 div
  clearTimeout(hoverTimeout)

  // 设置一个新的定时器，500 毫秒后改变背景色
  hoverTimeout = setTimeout(() => {
    isHovered.value = true
  }, 500)
}

const handleMouseLeave = () => {
  // 清除定时器，因为鼠标已经离开了
  clearTimeout(hoverTimeout)
  if (!isResizing) {
    // 立即将背景色设置回透明
    isHovered.value = false
  }
}
function startResize(e: MouseEvent) {
  e.preventDefault && e.preventDefault()
  isResizing = true
  isHovered.value = true
  startX = e.clientX
  document.addEventListener('mousemove', resize)
  document.addEventListener('mouseup', stopResize)
}

function resize(e: MouseEvent) {
  if (!isResizing) return
  const deltaX = e.clientX - startX

  // 获取窗口宽度
  const windowWidth = window.innerWidth

  const maxWidth = windowWidth - 100

  // 新宽度需要在最小值150和最大值之间
  const newWidth = Math.min(maxWidth, Math.max(150, runtime.layoutConfig.libraryAreaWidth + deltaX))

  if (runtime.layoutConfig.libraryAreaWidth + deltaX < 50) {
    runtime.layoutConfig.libraryAreaWidth = 0
  }
  if (newWidth != 150) {
    runtime.layoutConfig.libraryAreaWidth = newWidth
    startX = e.clientX
  }
}

function stopResize() {
  isResizing = false
  isHovered.value = false
  document.removeEventListener('mousemove', resize)
  document.removeEventListener('mouseup', stopResize)
  window.electron.ipcRenderer.send('layoutConfigChanged', JSON.stringify(runtime.layoutConfig))
}

const triggerLibrarySwitchAnimation = (shouldSkip = false) => {
  if (shouldSkip) return
  librarySwitching.value = false
  if (librarySwitchTimer) {
    clearTimeout(librarySwitchTimer)
  }
  requestAnimationFrame(() => {
    librarySwitching.value = true
    librarySwitchTimer = setTimeout(() => {
      librarySwitching.value = false
    }, 220)
  })
}

const adjustLibraryWidth = () => {
  const windowWidth = window.innerWidth
  const maxWidth = windowWidth - 100

  // 如果当前宽度超过最大允许宽度，才进行调整
  if (runtime.layoutConfig.libraryAreaWidth > maxWidth) {
    runtime.layoutConfig.libraryAreaWidth = maxWidth
    window.electron.ipcRenderer.send('layoutConfigChanged', JSON.stringify(runtime.layoutConfig))
  }
}

onMounted(() => {
  window.addEventListener('resize', adjustLibraryWidth)
})

onUnmounted(() => {
  window.removeEventListener('resize', adjustLibraryWidth)
  document.removeEventListener('mousemove', resize)
  document.removeEventListener('mouseup', stopResize)
  clearTimeout(hoverTimeout)
  if (librarySwitchTimer) {
    clearTimeout(librarySwitchTimer)
  }
})

let librarySelected = ref('FilterLibrary')
const normalizeLibraryPath = (value: string) => (value || '').replace(/\\/g, '/')
const isSongListUnderLibrary = (
  uuid: string,
  libraryName: 'FilterLibrary' | 'CuratedLibrary'
): boolean => {
  if (!uuid) return false
  const node = libraryUtils.getLibraryTreeByUUID(uuid)
  if (!node || node.type !== 'songList') return false
  const dirPath = libraryUtils.findDirPathByUuid(uuid)
  if (!dirPath) return false
  const normalized = normalizeLibraryPath(dirPath)
  const prefix = `library/${libraryName}`
  return normalized === prefix || normalized.startsWith(`${prefix}/`)
}
const resolveStoredSongListUUID = (libraryName: 'FilterLibrary' | 'CuratedLibrary'): string => {
  const candidate = runtime.lastSongListUUIDByLibrary[libraryName]
  if (!candidate) return ''
  return isSongListUnderLibrary(candidate, libraryName) ? candidate : ''
}

watch(
  () => runtime.songsArea.songListUUID,
  (uuid) => {
    if (!uuid || uuid === EXTERNAL_PLAYLIST_UUID || uuid === RECYCLE_BIN_UUID) return
    const currentLibrary = runtime.libraryAreaSelected
    if (currentLibrary !== 'FilterLibrary' && currentLibrary !== 'CuratedLibrary') return
    if (!isSongListUnderLibrary(uuid, currentLibrary)) return
    runtime.lastSongListUUIDByLibrary[currentLibrary] = uuid
  }
)
watch(
  () => runtime.libraryAreaSelected,
  (val, oldVal) => {
    librarySelected.value = val
    if (val === 'ExternalPlaylist') {
      if (runtime.songsArea.songListUUID !== EXTERNAL_PLAYLIST_UUID) {
        runtime.songsArea.songListUUID = EXTERNAL_PLAYLIST_UUID
      }
    }
    if (val === 'RecycleBin') {
      if (runtime.songsArea.songListUUID !== RECYCLE_BIN_UUID) {
        runtime.songsArea.songListUUID = RECYCLE_BIN_UUID
      }
    } else if (val === 'FilterLibrary' || val === 'CuratedLibrary') {
      const storedUuid = resolveStoredSongListUUID(val)
      const currentUuid = runtime.songsArea.songListUUID
      const hasCurrent = isSongListUnderLibrary(currentUuid, val)
      if (storedUuid) {
        if (currentUuid !== storedUuid) {
          runtime.songsArea.songListUUID = storedUuid
        }
      } else if (hasCurrent) {
        runtime.lastSongListUUIDByLibrary[val] = currentUuid
      } else if (!hasCurrent) {
        if (
          currentUuid === RECYCLE_BIN_UUID ||
          currentUuid === EXTERNAL_PLAYLIST_UUID ||
          currentUuid
        ) {
          runtime.songsArea.songListUUID = ''
        }
      }
    }
    triggerLibrarySwitchAnimation(oldVal === undefined)
  },
  { immediate: true }
)
const librarySelectedChange = (item: Icon) => {
  if (item.name == librarySelected.value) {
    return
  }
  librarySelected.value = item.name
}
let dragOverSongsArea = ref(false)
const isExternalPlaylistView = computed(() => runtime.libraryAreaSelected === 'ExternalPlaylist')
const isRecycleBinView = computed(() => runtime.libraryAreaSelected === 'RecycleBin')
const isLibraryPanelHidden = computed(() => isExternalPlaylistView.value || isRecycleBinView.value)
const isInternalSongDrag = (e: DragEvent) => {
  return (
    (runtime.songDragActive && runtime.draggingSongFilePaths.length > 0) ||
    e.dataTransfer?.types?.includes('application/x-song-drag')
  )
}
const dragover = (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }

  // 如果是歌曲拖拽，忽略处理
  if (isInternalSongDrag(e)) {
    return
  }

  if (isRecycleBinView.value) {
    e.dataTransfer.dropEffect = 'none'
    dragOverSongsArea.value = false
    return
  }

  if (isExternalPlaylistView.value) {
    e.dataTransfer.dropEffect = 'copy'
    dragOverSongsArea.value = true
    return
  }

  if (runtime.dragItemData !== null || !runtime.songsArea.songListUUID) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  if (runtime.dragTableHeader) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  e.dataTransfer.dropEffect = 'move'
  dragOverSongsArea.value = true
}
const dragleave = (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }

  // 如果是歌曲拖拽，忽略处理
  if (isInternalSongDrag(e)) {
    return
  }

  if (isRecycleBinView.value) {
    dragOverSongsArea.value = false
    return
  }

  if (isExternalPlaylistView.value) {
    dragOverSongsArea.value = false
    return
  }

  if (runtime.dragItemData !== null || !runtime.songsArea.songListUUID) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  if (runtime.dragTableHeader) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  dragOverSongsArea.value = false
}

const drop = async (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }

  // 如果是歌曲拖拽，忽略处理
  if (isInternalSongDrag(e)) {
    return
  }

  if (isRecycleBinView.value) {
    dragOverSongsArea.value = false
    return
  }

  if (isExternalPlaylistView.value) {
    dragOverSongsArea.value = false
    const filePaths: string[] = []
    for (let item of Array.from(e.dataTransfer.files)) {
      const resolved = window.api.showFilesPath(item)
      if (resolved) {
        filePaths.push(resolved)
      }
    }
    if (filePaths.length) {
      try {
        await appendExternalPlaylistFromPaths(filePaths)
      } catch (error) {
        console.error('[external-playlist] append failed', error)
      }
    }
    return
  }

  if (runtime.dragItemData !== null || !runtime.songsArea.songListUUID) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  if (runtime.dragTableHeader) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  dragOverSongsArea.value = false
  const filePaths = []
  for (let item of Array.from(e.dataTransfer.files)) {
    filePaths.push(window.api.showFilesPath(item))
  }

  let songListPath = libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    await confirm({
      title: t('common.error'),
      content: [t('library.notExistOnDisk')],
      confirmShow: false
    })
    let libraryTree = libraryUtils.getLibraryTreeByUUID(runtime.songsArea.songListUUID)
    if (libraryTree === null) {
      throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
    }
    let fatherDirData = libraryUtils.getFatherLibraryTreeByUUID(runtime.songsArea.songListUUID)
    if (fatherDirData === null) {
      throw new Error(`fatherDirData error: ${JSON.stringify(fatherDirData)}`)
    }
    let songListItem = libraryUtils.getLibraryTreeByUUID(runtime.songsArea.songListUUID)
    if (songListItem === null) {
      throw new Error(`songListItem error: ${JSON.stringify(songListItem)}`)
    }
    libraryUtils.updatePlayingState(songListItem)
    let deleteIndex
    if (fatherDirData.children === undefined) {
      throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
    }
    for (let index in fatherDirData.children) {
      if (fatherDirData.children[index] == libraryTree) {
        deleteIndex = index
        continue
      }
      if (fatherDirData.children[index].order && libraryTree.order) {
        if (fatherDirData.children[index].order > libraryTree.order) {
          fatherDirData.children[index].order--
        }
      }
    }
    fatherDirData.children.splice(Number(deleteIndex), 1)
    libraryUtils.diffLibraryTreeExecuteFileOperation()
    return
  }
  let result = await dropIntoDialog({
    songListUuid: runtime.songsArea.songListUUID,
    libraryName: librarySelected.value
  })
  if (result === 'cancel') {
    return
  }
  runtime.importingSongListUUID = result.importingSongListUUID
  runtime.isProgressing = true
  window.electron.ipcRenderer.send('startImportSongs', {
    filePaths: filePaths,
    songListPath: result.songListPath,
    isDeleteSourceFile: result.isDeleteSourceFile,
    isComparisonSongFingerprint: result.isComparisonSongFingerprint,
    isPushSongFingerprintLibrary: result.isPushSongFingerprintLibrary,
    deduplicateMode: result.deduplicateMode,
    songListUUID: result.importingSongListUUID
  })
}
</script>
<template>
  <div style="display: flex; height: 100%; min-width: 0; overflow: hidden">
    <librarySelectArea
      @librarySelectedChange="librarySelectedChange"
      style="flex-shrink: 0"
    ></librarySelectArea>
    <div style="flex-grow: 1; min-width: 0; overflow: hidden">
      <div
        style="
          display: flex;
          height: calc(100% - 51px);
          min-width: 0;
          overflow: hidden;
          position: relative;
        "
      >
        <div
          v-show="!isLibraryPanelHidden"
          class="libraryPanel"
          style="border-right: 1px solid var(--border); flex-shrink: 0"
          :class="{ librarySwitching }"
          :style="'width:' + runtime.layoutConfig.libraryAreaWidth + 'px'"
        >
          <div
            v-for="item of runtime.libraryTree.children"
            style="width: 100%; height: 100%"
            v-show="librarySelected == item.dirName"
          >
            <libraryArea :uuid="item.uuid"></libraryArea>
          </div>
        </div>
        <div
          v-show="!isLibraryPanelHidden"
          class="dragBar"
          :style="{ left: dragBarLeft }"
          @mousedown="startResize"
          @mouseenter="handleMouseEnter"
          @mouseleave="handleMouseLeave"
          :class="{ dragBarHovered: isHovered }"
        ></div>
        <div
          style="
            flex: 1;
            background-color: var(--bg);
            border: 1px solid transparent;
            min-width: 0;
            overflow: hidden;
          "
          :class="{ songsAreaDragHoverBorder: dragOverSongsArea }"
          @dragover.stop.prevent="dragover"
          @dragleave.stop="dragleave"
          @drop.stop.prevent="drop"
        >
          <songsArea style="width: 100%; height: 100%; min-width: 0" />
        </div>
      </div>
      <div style="height: 50px; border-top: 1px solid var(--border)">
        <songPlayer />
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.libraryPanel {
  &.librarySwitching {
    animation: librarySwitchFade 220ms ease;
  }
}

@keyframes librarySwitchFade {
  0% {
    opacity: 0;
    transform: translateY(6px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .libraryPanel.librarySwitching {
    animation: none;
  }
}

.dragBar {
  position: absolute;
  top: 0;
  height: 100%;
  width: 8px;
  /* 触发区域宽度 */
  cursor: ew-resize;
  transform: translateX(-50%);
  /* 将 8px 的触发区域居中在 left 位置 */
  z-index: 10;
  /* 确保它在其他内容之上 */
  background-color: transparent;
  /* 确保触发区域不可见 */
}

.dragBar::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  /* 相对于 dragBar 居中 */
  transform: translateX(-50%);
  /* 精确居中 */
  width: 4px;
  /* 宽度始终为 4px */
  height: 100%;
  background-color: #0078d4;
  /* 指示器颜色 */
  opacity: 0;
  /* 初始透明度为 0 */
  transition: opacity 0.2s ease;
  /* 过渡效果应用在透明度上 */
  pointer-events: none;
  /* 伪元素不应捕获事件 */
}

/* 当 dragBar 悬停或拖动时，显示伪元素 */
.dragBar.dragBarHovered::before {
  opacity: 1;
  /* 透明度变为 1 */
  /* width: 4px;  不再需要修改宽度 */
}

.songsAreaDragHoverBorder {
  /* 移除默认边框样式 */
  border-color: transparent !important;
  position: relative !important;
}

/* 添加伪元素来创建永远位于顶层的边框 */
.songsAreaDragHoverBorder::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 2px;
  bottom: 0;
  border: 1px solid #0078d4;
  pointer-events: none;
  /* 不影响鼠标事件 */
  z-index: 1000;
  /* 确保在所有内容之上 */
}
</style>
