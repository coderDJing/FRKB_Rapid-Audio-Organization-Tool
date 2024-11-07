<script setup lang="ts">
import librarySelectArea from './modules/librarySelectArea.vue'
import libraryArea from './modules/libraryArea.vue'
import songsArea from './modules/songsArea.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { onUnmounted, ref } from 'vue'
import songPlayer from './modules/songPlayer.vue'
import dropIntoDialog from '../components/dropIntoDialog'
import { Icon } from 'src/types/globals'
import libraryUtils from '@renderer/utils/libraryUtils'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
const runtime = useRuntimeStore()
let startX = 0
let isResizing = false
const isHovered = ref(false)
let hoverTimeout: NodeJS.Timeout

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
  const newWidth = Math.max(150, runtime.layoutConfig.libraryAreaWidth + deltaX) // 设置最小宽度
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

onUnmounted(() => {
  // 如果需要，可以在这里添加组件卸载时的清理逻辑
  document.removeEventListener('mousemove', resize)
  document.removeEventListener('mouseup', stopResize)
  clearTimeout(hoverTimeout)
})

let librarySelected = ref('筛选库')
const librarySelectedChange = (item: Icon) => {
  if (item.name == librarySelected.value) {
    return
  }
  librarySelected.value = item.name
}
let dragOverSongsArea = ref(false)
const dragover = (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
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
  if (runtime.dragItemData !== null || !runtime.songsArea.songListUUID) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  if (runtime.dragTableHeader) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  dragOverSongsArea.value = false

  let files = Array.from(e.dataTransfer.files)

  let songListPath = libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    await confirm({
      title: '错误',
      content: [t('此歌单/文件夹在磁盘中不存在，可能已被手动删除')],
      confirmShow: false
    })
    let libraryTree = libraryUtils.getLibraryTreeByUUID(runtime.songsArea.songListUUID)
    if (libraryTree === null) {
      throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
    }
    let fatherDirData = libraryUtils.getFatherLibraryTreeByUUID(runtime.songsArea.songListUUID)
    const path = libraryUtils.findDirPathByUuid(runtime.songsArea.songListUUID)
    if (fatherDirData === null) {
      throw new Error(`fatherDirData error: ${JSON.stringify(fatherDirData)}`)
    }
    let uuids = libraryUtils.getAllUuids(libraryTree)
    if (uuids.indexOf(runtime.songsArea.songListUUID) !== -1) {
      runtime.songsArea.songListUUID = ''
    }
    if (uuids.indexOf(runtime.playingData.playingSongListUUID) !== -1) {
      runtime.playingData.playingSongListUUID = ''
      runtime.playingData.playingSongListData = []
      runtime.playingData.playingSong = null
    }
    await window.electron.ipcRenderer.invoke('delDir', path)
    await window.electron.ipcRenderer.invoke(
      'updateOrderAfterNum',
      libraryUtils.findDirPathByUuid(fatherDirData.uuid),
      libraryTree.order
    )
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
    return
  }
  let result = await dropIntoDialog({
    songListUuid: runtime.songsArea.songListUUID,
    libraryName: librarySelected.value
  })
  if (result === 'cancel') {
    return
  }
  let filePaths = []
  for (let item of files) {
    filePaths.push(item.path)
  }
  runtime.importingSongListUUID = result.importingSongListUUID
  runtime.isProgressing = true
  window.electron.ipcRenderer.send('startImportSongs', {
    filePaths: filePaths,
    songListPath: result.songListPath,
    isDeleteSourceFile: result.isDeleteSourceFile,
    isComparisonSongFingerprint: result.isComparisonSongFingerprint,
    isPushSongFingerprintLibrary: result.isPushSongFingerprintLibrary,
    songListUUID: result.importingSongListUUID
  })
}
</script>
<template>
  <div style="display: flex; height: 100%">
    <librarySelectArea
      @librarySelectedChange="librarySelectedChange"
      style="flex-shrink: 0"
    ></librarySelectArea>
    <div style="flex-grow: 1">
      <div style="display: flex; height: calc(100% - 51px)">
        <div
          style="width: 200px; border-right: 1px solid #2b2b2b; flex-shrink: 0"
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
          style="width: 4px; cursor: ew-resize; height: calc(100%); flex-shrink: 0"
          @mousedown="startResize"
          class="dragBar"
          @mouseenter="handleMouseEnter"
          @mouseleave="handleMouseLeave"
          :class="{ dragBarHovered: isHovered }"
        ></div>
        <div
          style="flex: 1; background-color: #181818; border: 1px solid transparent"
          :class="{ songsAreaDragHoverBorder: dragOverSongsArea }"
          @dragover.stop.prevent="dragover"
          @dragleave.stop="dragleave"
          @drop.stop.prevent="drop"
        >
          <songsArea />
        </div>
      </div>
      <div style="height: 50px; border-top: 1px solid #2b2b2b">
        <songPlayer />
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.dragBar {
  background-color: transparent;
  transition: background-color 0.2s ease;
}

.dragBarHovered {
  background-color: #0078d4;
}

.songsAreaDragHoverBorder {
  border: 1px solid #0078d4 !important;
}
</style>
