<script setup lang="ts">
import { computed, ref, useTemplateRef, nextTick } from 'vue'
import libraryItem from '@renderer/components/libraryItem/index.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import rightClickMenu from '../../components/rightClickMenu'
import { t, toLibraryDisplayName } from '@renderer/utils/translate'
import emitter from '../../utils/mitt'
import { handleLibraryAreaEmptySpaceDrop } from '@renderer/utils/dragUtils'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import type { IDir } from 'src/types/globals'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'

const runtime = useRuntimeStore()
const props = defineProps({
  uuid: {
    type: String,
    required: true
  }
})
let libraryData = libraryUtils.getLibraryTreeByUUID(props.uuid)

if (libraryData === null) {
  throw new Error(`libraryData error: ${JSON.stringify(libraryData)}`)
}

const displayedChildren = computed(() => {
  if (runtime.libraryAreaSelected === 'RecycleBin' && libraryData.children) {
    // 创建一个倒序副本，不改变原数组
    return [...libraryData.children].reverse()
  }
  return libraryData.children
})

const showHint = computed(() => {
  const children = libraryData.children
  const hasSpecialChild = children?.some((child) =>
    ['filterLibrarySonglistDemo1', 'curatedLibrarySonglistDemo1'].includes(child.uuid)
  )
  return !children?.length || (children?.length === 1 && hasSpecialChild)
})
const collapseButtonRef = useTemplateRef<HTMLDivElement>('collapseButtonRef')

// 将核心库名称映射为 i18n key，仅用于显示
const libraryTitleText = computed(() => toLibraryDisplayName(libraryData.dirName))

const emptyRecycleBinHandleClick = async () => {
  let res = await confirm({
    title: t('recycleBin.emptyRecycleBin'),
    content: [t('recycleBin.confirmEmpty'), t('tracks.deleteHint')]
  })
  if (res !== 'confirm') {
    return
  }

  await window.electron.ipcRenderer.invoke('emptyRecycleBin')

  // 若当前打开回收站，则刷新列表
  if (runtime.songsArea.songListUUID === RECYCLE_BIN_UUID) {
    runtime.songsArea.songListUUID = ''
    runtime.songsArea.selectedSongFilePath.length = 0
    await nextTick()
    runtime.songsArea.songListUUID = RECYCLE_BIN_UUID
  }

  // 若当前正在播放来自回收站，则停止播放并清空播放列表
  if (runtime.playingData.playingSongListUUID === RECYCLE_BIN_UUID) {
    runtime.playingData.playingSong = null
    runtime.playingData.playingSongListUUID = ''
    runtime.playingData.playingSongListData = []
  }
}

// 歌单筛选关键词（仅匹配歌单名）
const playlistSearch = ref('')
// 扁平化当前库下的全部歌单（不关心折叠状态）
const allSongListArr = computed<IDir[]>(() => {
  const result: IDir[] = []
  const traverse = (node?: IDir) => {
    if (!node) return
    if (node.type === 'songList' || node.type === 'mixtapeList') result.push(node)
    if (node.children && node.children.length) {
      for (const child of node.children) traverse(child as IDir)
    }
  }
  traverse(libraryData as unknown as IDir)
  return result
})
const exactMatchExists = computed(() => {
  const keyword = String(playlistSearch.value || '')
    .trim()
    .toLowerCase()
  if (!keyword) return true
  return allSongListArr.value.some((x) => (x.dirName || '').toLowerCase() === keyword)
})
const directNameConflictExists = computed(() => {
  const keyword = String(playlistSearch.value || '')
    .trim()
    .toLowerCase()
  if (!keyword) return false
  const siblings = libraryData.children || []
  return siblings.some(
    (item) =>
      String(item?.dirName || '')
        .trim()
        .toLowerCase() === keyword
  )
})
const showCreateNow = computed(() => {
  const keyword = String(playlistSearch.value || '').trim()
  if (!keyword) return false
  // 回收站中不显示立即创建
  if (runtime.libraryAreaSelected === 'RecycleBin') return false
  return !exactMatchExists.value && !directNameConflictExists.value
})
const isMixtapeLibrary = computed(() => runtime.libraryAreaSelected === 'MixtapeLibrary')
const createNow = async () => {
  const name = String(playlistSearch.value || '').trim()
  if (!name) return
  const invalidCharsRegex = /[<>:"/\\|?*\u0000-\u001F]/
  if (invalidCharsRegex.test(name)) {
    await confirm({
      title: t('common.error'),
      content: [t('library.nameInvalidChars')],
      confirmShow: false
    })
    return
  }
  if (directNameConflictExists.value) {
    await confirm({
      title: t('common.error'),
      content: [t('library.nameAlreadyExists', { name })],
      confirmShow: false
    })
    return
  }
  const newUuid = uuidV4()
  for (let item of libraryData.children || []) {
    if (item.order) item.order++
  }
  libraryData.children = libraryData.children || []
  libraryData.children.unshift({
    uuid: newUuid,
    type: isMixtapeLibrary.value ? 'mixtapeList' : 'songList',
    dirName: name,
    order: 1,
    children: []
  } as IDir)
  try {
    await libraryUtils.diffLibraryTreeExecuteFileOperation()
  } catch {}
  // 创建完成后清空搜索
  playlistSearch.value = ''
}

const menuArr = ref([
  [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]
])
const contextmenuEvent = async (event: MouseEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    menuArr.value = [[{ menuName: 'recycleBin.emptyRecycleBin' }]]
  } else if (runtime.libraryAreaSelected === 'MixtapeLibrary') {
    menuArr.value = [[{ menuName: 'library.createMixtape' }, { menuName: 'library.createFolder' }]]
  } else {
    menuArr.value = [[{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]]
  }
  let result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
  if (result !== 'cancel') {
    if (result.menuName == 'library.createPlaylist') {
      const newUuid = uuidV4()
      libraryData.children = libraryData.children || []
      libraryData.children.unshift({
        uuid: newUuid,
        type: 'songList',
        dirName: ''
      })
      // 不在此时标记“创建中”，等待命名确认开始写盘时再标记
    } else if (result.menuName == 'library.createMixtape') {
      const newUuid = uuidV4()
      libraryData.children = libraryData.children || []
      libraryData.children.unshift({
        uuid: newUuid,
        type: 'mixtapeList',
        dirName: ''
      })
    } else if (result.menuName == 'library.createFolder') {
      libraryData.children?.unshift({
        uuid: uuidV4(),
        type: 'dir',
        dirName: ''
      })
    } else if (result.menuName == 'recycleBin.emptyRecycleBin') {
      emptyRecycleBinHandleClick()
    }
  }
}

const collapseButtonHandleClick = async () => {
  emitter.emit('collapseButtonHandleClick', libraryData.dirName)
}

const dragApproach = ref('')
const dragover = (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'none'
    }
    return
  }
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return
  }
  e.dataTransfer.dropEffect = 'move'
  dragApproach.value = 'top'
}
const dragenter = (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'none'
    }
    return
  }
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return
  }
  e.dataTransfer.dropEffect = 'move'
  dragApproach.value = 'top'
}
const dragleave = (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    return
  }
  if (runtime.dragItemData === null) {
    if (e.dataTransfer === null) {
      throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
    }
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return
  }
  dragApproach.value = ''
}
const drop = async (e: DragEvent) => {
  if (runtime.libraryAreaSelected === 'RecycleBin') {
    runtime.dragItemData = null
    return
  }
  if (runtime.dragItemData === null) {
    if (e.dataTransfer === null) {
      throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
    }
    e.dataTransfer.dropEffect = 'none'
    runtime.dragItemData = null
    return
  }

  dragApproach.value = ''

  try {
    // 使用 dragUtils 中的函数处理拖放到空白区域
    const handled = await handleLibraryAreaEmptySpaceDrop(runtime.dragItemData, libraryData)

    // 如果处理成功或失败，都清除拖拽数据
  } catch (error) {
    console.error('Drop operation failed:', error)
  } finally {
    runtime.dragItemData = null
  }
}
</script>
<template>
  <div class="content" @contextmenu.stop="contextmenuEvent">
    <div class="unselectable libraryTitle">
      <span>{{ libraryTitleText }}</span>
      <!-- todo还有个导出整个库的按钮 -->
      <div style="display: flex; justify-content: center; align-items: center">
        <div ref="collapseButtonRef" class="collapseButton" @click="collapseButtonHandleClick()">
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
    <!-- 顶部筛选输入框 -->
    <div class="librarySearchWrapper">
      <div class="searchRow">
        <div class="searchInputWrapper">
          <input
            v-model="playlistSearch"
            class="searchInput"
            :placeholder="t('playlist.searchPlaylists')"
          />
          <div
            v-show="String(playlistSearch || '').length"
            class="clearBtn"
            @click="playlistSearch = ''"
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
        <div v-if="showCreateNow" class="createNowBtn" @click="createNow">
          {{ t('playlist.createNow') }}
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
        <template v-for="item of displayedChildren" :key="item.uuid">
          <libraryItem
            v-if="!(runtime.selectSongListDialogShow && !item.dirName)"
            :uuid="item.uuid"
            :library-name="libraryData.dirName"
            :filter-text="playlistSearch"
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
          :class="{ borderTop: dragApproach == 'top' }"
          @dragover.stop.prevent="dragover"
          @dragenter.stop.prevent="dragenter"
          @drop.stop="drop"
          @dragleave.stop="dragleave"
        >
          <span
            v-show="showHint && runtime.layoutConfig.libraryAreaWidth !== 0"
            style="font-size: 12px; color: #8c8c8c; position: absolute; bottom: 50vh"
          >
            {{
              runtime.libraryAreaSelected === 'RecycleBin'
                ? t('recycleBin.noDeletionRecords')
                : t('library.rightClickToCreate')
            }}
          </span>
        </div>
      </OverlayScrollbarsComponent>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.borderTop {
  box-shadow: inset 0 1px 0 0 var(--accent);
}

.libraryArea {
  height: calc(100% - 35px);
  max-height: calc(100% - 35px);
  width: 100%;
  display: flex;
  flex-direction: column;
}

.content {
  height: 100%;
  width: 100%;
  display: flex;
  flex-grow: 1;
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
}

// 当鼠标悬停在输入框容器（包括清空按钮）时，也应用输入框的 hover 效果
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
  padding-right: 24px; // 为清空按钮预留空间
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

.bubbleBox {
  height: 22px;
  line-height: 22px;
  text-align: center;
  position: relative;
  border-radius: 3px;
  border: 1px solid var(--border);
  font-size: 12px;
  background-color: var(--bg-elev);
  padding: 0 10px;
  font-weight: normal;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter,
.fade-leave-to {
  opacity: 0;
}
</style>
