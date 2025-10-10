<script setup lang="ts">
import { ref, nextTick, useTemplateRef, reactive, onMounted, watch } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import dialogLibraryItem from '@renderer/components/dialogLibraryItem/index.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import listIcon from '@renderer/assets/listIcon.png?asset'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import emitter from '../../utils/mitt'
import {
  handleDragStart,
  handleDragOver,
  handleDragEnter,
  handleDragLeave,
  handleDrop,
  type DragState
} from '../../utils/dragUtils'
const props = defineProps({
  uuid: {
    type: String,
    required: true
  },
  libraryName: {
    type: String
  },
  needPaddingLeft: {
    type: Boolean,
    default: true
  },
  // 当父组件需要控制“避免与最近使用区重复高亮”时，传入 true
  suppressHighlight: {
    type: Boolean,
    default: false
  }
})
const runtime = useRuntimeStore()
let dirData = libraryUtils.getLibraryTreeByUUID(props.uuid)
if (dirData === null) {
  throw new Error(`dirData error: ${JSON.stringify(dirData)}`)
}
let fatherDirData = libraryUtils.getFatherLibraryTreeByUUID(props.uuid)
const myInputHandleInput = () => {
  const newName = operationInputValue.value
  const invalidCharsRegex = /[<>:"/\\|?*\u0000-\u001F]/
  let hintShouldShow = false
  let hintText = ''

  if (!fatherDirData) return // Keep existing null check

  if (newName === '') {
    hintText = t('library.nameRequired')
    hintShouldShow = true
  } else if (invalidCharsRegex.test(newName)) {
    hintText = t('library.nameInvalidChars')
    hintShouldShow = true
  } else {
    const exists = fatherDirData.children?.some((obj) => obj.dirName === newName)
    if (exists) {
      hintText = t('library.nameAlreadyExists', { name: newName })
      hintShouldShow = true
    }
  }

  inputHintText.value = hintText
  inputHintShow.value = hintShouldShow
}

const inputKeyDownEnter = () => {
  // Rely on inputHintShow which is now correctly updated
  if (inputHintShow.value || operationInputValue.value === '') {
    if (!inputHintShow.value) {
      inputHintText.value = t('library.nameRequired')
      inputHintShow.value = true
    }
    return
  }
  myInput.value?.blur() // Proceed to blur if valid
}

const inputKeyDownEsc = () => {
  operationInputValue.value = '' // Clear value on Esc
  inputHintShow.value = false // Hide hint
  inputBlurHandle() // Trigger blur logic (which handles cleanup if needed)
}

const inputHintText = ref('')
const inputBlurHandle = async () => {
  if (inputHintShow.value || operationInputValue.value == '') {
    if (dirData && dirData.dirName == '') {
      if (fatherDirData && fatherDirData.children && fatherDirData.children[0]?.dirName == '') {
        fatherDirData.children.shift()
      }
    }
    operationInputValue.value = ''
    inputHintShow.value = false
    return
  }

  if (!fatherDirData) return
  if (fatherDirData.children === undefined) {
    throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
  }

  if (dirData) {
    for (let item of fatherDirData.children) {
      if (item.order) {
        item.order++
      }
    }
    dirData.dirName = operationInputValue.value
    dirData.order = 1
    dirData.children = []
    operationInputValue.value = ''

    await libraryUtils.diffLibraryTreeExecuteFileOperation()
    // 命名完成并写盘成功后，再在对话框中高亮该歌单（不触发双击）
    if (dirData.type === 'songList') {
      runtime.dialogSelectedSongListUUID = dirData.uuid
      emits('markTreeSelected')
      // 命名完成后刷新曲目数量显示（此时目录已存在）
      try {
        await ensureTrackCount()
      } catch {}
    }
    // 清除创建中标记
    if (runtime.creatingSongListUUID === dirData.uuid) {
      runtime.creatingSongListUUID = ''
    }
  }
}
let operationInputValue = ref('')

const inputHintShow = ref(false)

const myInput = useTemplateRef('myInput')
const rowEl = useTemplateRef('rowEl')
if (dirData && dirData.dirName == '') {
  nextTick(() => {
    myInput.value?.focus()
  })
}

const rightClickMenuShow = ref(false)
const menuArr = ref(
  dirData?.type == 'dir'
    ? [
        [{ menuName: '新建歌单' }, { menuName: '新建文件夹' }],
        [{ menuName: '重命名' }, { menuName: '删除' }]
      ]
    : [[{ menuName: '重命名' }, { menuName: '删除歌单' }]]
)
const deleteDir = async () => {
  let libraryTree = libraryUtils.getLibraryTreeByUUID(props.uuid)
  if (libraryTree === null) {
    throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
  }

  // --- Add logic to update songsArea and playingData ---
  let uuids = libraryUtils.getAllUuids(libraryTree) // Get all UUIDs within the item being deleted

  // If the deleted item or its children contain the currently viewed songlist
  if (uuids.indexOf(runtime.songsArea.songListUUID) !== -1) {
    runtime.songsArea.songListUUID = '' // Clear the currently viewed songlist
    // Optionally clear other related states like selectedSongFilePath, songInfoArr if necessary
    runtime.songsArea.selectedSongFilePath.length = 0
    runtime.songsArea.songInfoArr = []
  }
  // If the deleted item or its children contain the currently playing songlist
  if (uuids.indexOf(runtime.playingData.playingSongListUUID) !== -1) {
    runtime.playingData.playingSongListUUID = '' // Clear playing songlist UUID
    runtime.playingData.playingSongListData = [] // Clear playing list data
    runtime.playingData.playingSong = null // Clear the currently playing song
  }
  // --- End added logic ---

  if (!fatherDirData) return

  let deleteIndex
  if (fatherDirData.children === undefined) {
    throw new Error(`fatherDirData.children error: ${JSON.stringify(fatherDirData.children)}`)
  }
  for (let index in fatherDirData.children) {
    if (fatherDirData.children[index] == dirData) {
      deleteIndex = index
      continue
    }
    if (fatherDirData.children[index].order && dirData.order) {
      if (fatherDirData.children[index].order > dirData.order) {
        fatherDirData.children[index].order--
      }
    }
  }
  fatherDirData.children.splice(Number(deleteIndex), 1)
  await libraryUtils.diffLibraryTreeExecuteFileOperation()
}
const contextmenuEvent = async (event: MouseEvent) => {
  let songListPath = libraryUtils.findDirPathByUuid(props.uuid)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    await confirm({
      title: t('common.error'),
      content: [t('library.notExistOnDisk')],
      confirmShow: false
    })
    deleteDir()
    return
  }
  rightClickMenuShow.value = true
  let result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
  rightClickMenuShow.value = false
  if (result !== 'cancel') {
    if (result.menuName == '新建歌单') {
      dirChildRendered.value = true
      dirChildShow.value = true
      const newUuid = uuidV4()
      if (dirData.children) {
        dirData.children.unshift({
          uuid: newUuid,
          dirName: '',
          type: 'songList'
        })
      }
      // 不在此时标记“创建中”，等待命名确认开始写盘时再标记
    } else if (result.menuName == '新建文件夹') {
      dirChildRendered.value = true
      dirChildShow.value = true
      dirData.children?.unshift({
        uuid: uuidV4(),
        dirName: '',
        type: 'dir'
      })
    } else if (result.menuName == '重命名') {
      renameDivShow.value = true
      renameDivValue.value = dirData.dirName
      await nextTick()
      myRenameInput.value?.focus()
    } else if (result.menuName === '删除' || result.menuName === '删除歌单') {
      deleteDir()
    }
  }
}

const dirChildShow = ref(false)
const dirChildRendered = ref(false)
const dirHandleClick = async () => {
  runtime.activeMenuUUID = ''
  let songListPath = libraryUtils.findDirPathByUuid(props.uuid)
  let isSongListPathExist = await window.electron.ipcRenderer.invoke('dirPathExists', songListPath)
  if (!isSongListPathExist) {
    await confirm({
      title: t('common.error'),
      content: [t('library.notExistOnDisk')],
      confirmShow: false
    })
    deleteDir()
    return
  }
  if (dirData.type == 'songList') {
    runtime.dialogSelectedSongListUUID = props.uuid
    emits('markTreeSelected')
  } else {
    dirChildRendered.value = true
    dirChildShow.value = !dirChildShow.value
  }
}
const emits = defineEmits(['dblClickSongList', 'markTreeSelected'])
const dirHandleDblClick = () => {
  if (dirData.type == 'songList') {
    emits('dblClickSongList')
  }
}

emitter.on('collapseButtonHandleClick', (libraryName) => {
  if (libraryName == props.libraryName) {
    dirChildShow.value = false
  }
})
//----重命名功能--------------------------------------
const renameDivShow = ref(false)
const renameDivValue = ref('')
const myRenameInput = useTemplateRef('myRenameInput')
const renameInputHintShow = ref(false)
const renameInputHintText = ref('')
const renameInputBlurHandle = async () => {
  if (
    renameInputHintShow.value ||
    renameDivValue.value == '' ||
    renameDivValue.value == dirData.dirName
  ) {
    renameDivValue.value = ''
    renameDivShow.value = false
    return
  }

  // --- Add missing updates for songsArea and playingData paths ---
  // If renaming the currently viewed songlist in songsArea (less likely in dialog, but for consistency)
  if (dirData.uuid === runtime.songsArea.songListUUID) {
    for (let item of runtime.songsArea.songInfoArr) {
      let arr = item.filePath.split('\\')
      arr[arr.length - 2] = renameDivValue.value
      item.filePath = arr.join('\\')
    }
    for (let index in runtime.songsArea.selectedSongFilePath) {
      let arr = runtime.songsArea.selectedSongFilePath[index].split('\\')
      arr[arr.length - 2] = renameDivValue.value
      runtime.songsArea.selectedSongFilePath[index] = arr.join('\\')
    }
  }
  // If renaming the currently playing songlist
  if (
    dirData.uuid === runtime.playingData.playingSongListUUID &&
    runtime.playingData.playingSong !== null
  ) {
    let arr = runtime.playingData.playingSong.filePath.split('\\')
    arr[arr.length - 2] = renameDivValue.value
    runtime.playingData.playingSong.filePath = arr.join('\\')
    for (let item of runtime.playingData.playingSongListData) {
      let arr = item.filePath.split('\\')
      arr[arr.length - 2] = renameDivValue.value
      item.filePath = arr.join('\\')
    }
  }
  // --- End added updates ---

  // Update name in memory first
  dirData.dirName = renameDivValue.value
  renameDivValue.value = ''
  renameDivShow.value = false

  await libraryUtils.diffLibraryTreeExecuteFileOperation()
}
const renameInputKeyDownEnter = () => {
  // Rely on renameInputHintShow which is now correctly updated
  if (renameInputHintShow.value || renameDivValue.value === '') {
    if (!renameInputHintShow.value) {
      renameInputHintText.value = t('library.nameRequired')
      renameInputHintShow.value = true
    }
    return
  }
  myRenameInput.value?.blur() // Proceed to blur if valid
}
const renameInputKeyDownEsc = () => {
  renameDivValue.value = '' // Clear value on Esc
  renameInputHintShow.value = false // Hide hint
  renameInputBlurHandle() // Trigger blur logic (which handles cleanup if needed)
}
const renameMyInputHandleInput = () => {
  const newName = renameDivValue.value
  const invalidCharsRegex = /[<>:"/\\|?*\u0000-\u001F]/
  let hintShouldShow = false
  let hintText = ''

  if (!fatherDirData) return // Keep existing null check

  if (newName === '') {
    hintText = t('library.nameRequired')
    hintShouldShow = true
  } else if (invalidCharsRegex.test(newName)) {
    hintText = t('library.nameInvalidChars')
    hintShouldShow = true
  } else {
    // Check if the new name exists AND it's not the original name of this item
    const exists = fatherDirData.children?.some(
      (obj) => obj.dirName === newName && obj.uuid !== props.uuid
    )
    if (exists) {
      hintText = t('library.nameAlreadyExists', { name: newName })
      hintShouldShow = true
    }
  }

  renameInputHintText.value = hintText
  renameInputHintShow.value = hintShouldShow
}

// 监听对话框重命名触发（无需先点击，直接对高亮项生效）
emitter.on('dialog/trigger-rename', async (targetUuid: string) => {
  try {
    if (targetUuid !== props.uuid) return
    if (!dirData?.dirName) return
    renameDivShow.value = true
    renameDivValue.value = dirData.dirName
    await nextTick()
    myRenameInput.value?.focus()
  } catch {}
})
//------------------------------------

const dragState = reactive<DragState>({
  dragApproach: ''
})

const dragstart = async (event: DragEvent) => {
  await handleDragStart(event, props.uuid)
  event.target?.addEventListener(
    'dragend',
    () => {
      runtime.dragItemData = null
    },
    { once: true }
  )
}

const dragover = (e: DragEvent) => {
  handleDragOver(e, dirData, dragState)
}

const dragenter = (e: DragEvent) => {
  handleDragEnter(e, dirData, dragState)
}

const dragleave = () => {
  handleDragLeave(dragState)
}

const drop = async (e: DragEvent) => {
  await handleDrop(e, dirData, dragState, fatherDirData)
}

const indentWidth = ref(0)
let depth = libraryUtils.getDepthByUuid(props.uuid)
if (depth === undefined) {
  throw new Error(`depth error: ${JSON.stringify(depth)}`)
}
indentWidth.value = (depth - 2) * 10

// 歌单曲目数量（对话框）
const trackCount = ref<number | null>(null)
let fetchingCount = false
async function ensureTrackCount() {
  if (!(runtime as any).setting.showPlaylistTrackCount) return
  if (fetchingCount) return
  if (dirData?.type !== 'songList') return
  // 未命名的临时歌单没有真实目录，避免把父目录当作歌单目录而统计成总数
  if (!dirData?.dirName) {
    trackCount.value = null
    return
  }
  try {
    fetchingCount = true
    const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
    const count = await window.electron.ipcRenderer.invoke('getSongListTrackCount', songListPath)
    trackCount.value = typeof count === 'number' ? count : 0
  } catch {
    trackCount.value = 0
  } finally {
    fetchingCount = false
  }
}

onMounted(() => {
  ensureTrackCount()
  // 当父组件要求抑制高亮（通常表示当前在“最近使用”区域高亮）时，避免树区自动滚动
  if (props.suppressHighlight) return
  if (runtime.dialogSelectedSongListUUID === props.uuid) {
    nextTick(() => {
      try {
        ;(rowEl.value as any)?.scrollIntoView?.({ block: 'nearest' })
      } catch {}
    })
  }
})

// 200ms 去抖 + 去重刷新（对话框）
let debounceTimer: any = null
const pendingSet = new Set<string>()
emitter.on('playlistContentChanged', (payload: any) => {
  try {
    const uuids: string[] = (payload?.uuids || []).filter(Boolean)
    for (const u of uuids) pendingSet.add(u)
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (pendingSet.has(props.uuid)) {
        // 对话框里若当前即为打开/高亮的歌单，也可以不经 IPC。此处直接刷一次即可。
        ensureTrackCount()
      }
      pendingSet.clear()
    }, 200)
  } catch {}
})

// 选中项变化时，若当前组件对应项被选中，使其滚动到可视区域内（对话框）
// 当 suppressHighlight 为 true（近期区高亮）时，不在树区触发自动滚动
watch(
  () => [runtime.dialogSelectedSongListUUID, props.suppressHighlight] as const,
  async ([newVal, suppress]) => {
    if (suppress) return
    if (newVal === props.uuid) {
      await nextTick()
      try {
        ;(rowEl.value as any)?.scrollIntoView?.({ block: 'nearest' })
      } catch {}
    }
  }
)
</script>
<template>
  <div
    class="mainBody"
    ref="rowEl"
    style="display: flex; box-sizing: border-box"
    :style="'padding-left:' + (props.needPaddingLeft ? indentWidth : 0) + 'px'"
    @contextmenu.stop="contextmenuEvent"
    @click.stop="dirHandleClick()"
    @dblclick="dirHandleDblClick()"
    @dragover.stop.prevent="dragover"
    @dragstart.stop="dragstart"
    @dragenter.stop.prevent="dragenter"
    @drop.stop="drop"
    @dragleave.stop="dragleave"
    :draggable="dirData.dirName && !renameDivShow ? true : false"
    :class="{
      rightClickBorder: rightClickMenuShow,
      borderTop: dragState.dragApproach == 'top',
      borderBottom: dragState.dragApproach == 'bottom',
      borderCenter: dragState.dragApproach == 'center',
      selectedDir: !props.suppressHighlight && props.uuid == runtime.dialogSelectedSongListUUID
    }"
  >
    <div class="prefixIcon">
      <svg
        v-if="dirData.type == 'dir'"
        v-show="!dirChildShow"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          clip-rule="evenodd"
          d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z"
        />
      </svg>
      <svg
        v-if="dirData.type == 'dir'"
        v-show="dirChildShow"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          clip-rule="evenodd"
          d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"
        />
      </svg>
      <img
        v-if="dirData.type == 'songList' && runtime.creatingSongListUUID !== props.uuid"
        style="width: 13px; height: 13px"
        :src="listIcon"
      />
      <div
        v-if="dirData.type == 'songList' && runtime.creatingSongListUUID === props.uuid"
        class="loading"
      ></div>
    </div>
    <div style="height: 23px; width: calc(100% - 20px)">
      <div v-if="dirData.dirName && !renameDivShow" class="nameRow">
        <span class="nameText">{{ dirData.dirName }}</span>
        <span
          v-if="
            dirData.type === 'songList' &&
            (runtime as any).setting.showPlaylistTrackCount &&
            trackCount !== null
          "
          class="countBadge"
          :title="t('tracks.title')"
          >{{ trackCount }}</span
        >
      </div>
      <div v-if="!dirData.dirName">
        <input
          ref="myInput"
          v-model="operationInputValue"
          class="myInput"
          :class="{ myInputRedBorder: inputHintShow }"
          @blur="inputBlurHandle"
          @keydown.enter="inputKeyDownEnter"
          @keydown.esc="inputKeyDownEsc"
          @click.stop="() => {}"
          @contextmenu.stop="() => {}"
          @input="myInputHandleInput"
        />
        <div v-show="inputHintShow" class="myInputHint">
          <div>{{ inputHintText }}</div>
        </div>
      </div>
      <div v-if="renameDivShow">
        <input
          ref="myRenameInput"
          v-model="renameDivValue"
          class="myInput"
          :class="{ myInputRedBorder: renameInputHintShow }"
          @blur="renameInputBlurHandle"
          @keydown.enter="renameInputKeyDownEnter"
          @keydown.esc="renameInputKeyDownEsc"
          @click.stop="() => {}"
          @contextmenu.stop="() => {}"
          @input="renameMyInputHandleInput"
        />
        <div v-show="renameInputHintShow" class="myInputHint">
          <div>{{ renameInputHintText }}</div>
        </div>
      </div>
    </div>
  </div>
  <div
    v-if="dirData.type == 'dir' && dirChildRendered"
    v-show="dirChildShow"
    style="width: 100%; box-sizing: border-box"
  >
    <template v-for="item of dirData.children" :key="item.uuid">
      <dialogLibraryItem
        :uuid="item.uuid"
        :libraryName="props.libraryName"
        :suppressHighlight="props.suppressHighlight"
        @markTreeSelected="emits('markTreeSelected')"
        @dblClickSongList="emits('dblClickSongList')"
      />
    </template>
  </div>
</template>
<style lang="scss" scoped>
.nameRow {
  line-height: 23px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 8px;
  position: relative;
}

.nameText {
  flex: 1 1 auto;
  min-width: 0;
  padding-right: 48px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.countBadge {
  min-width: 18px;
  height: 16px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
  background-color: #2d2e2e;
  color: #a0a0a0;
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
}
.selectedDir {
  background-color: #37373d;

  &:hover {
    background-color: #37373d !important;
  }
}

.mainBody {
  &:hover {
    background-color: #2a2d2e;
  }
}

.borderTop {
  box-shadow: inset 0 1px 0 0 #0078d4;
}

.borderBottom {
  box-shadow: inset 0 -1px 0 0 #0078d4;
}

.borderCenter {
  box-shadow: inset 0 0 0 1px #0078d4;
}

.rightClickBorder {
  box-shadow: inset 0 0 0 1px #0078d4;
}

.myInput {
  width: calc(100% - 6px);
  height: 19px;
  background-color: #313131;
  border: 1px solid #086bb7;
  outline: none;
  color: #cccccc;
}

.myInputRedBorder {
  border: 1px solid #be1100;
}

.myInputHint {
  div {
    width: calc(100% - 7px);
    min-height: 25px;
    line-height: 25px;
    background-color: #5a1d1d;
    border-right: 1px solid #be1100;
    border-left: 1px solid #be1100;
    border-bottom: 1px solid #be1100;
    font-size: 12px;
    padding-left: 5px;
    position: relative;
    z-index: 100;
  }
}

.prefixIcon {
  color: #cccccc;
  width: 20px;
  min-width: 20px;
  height: 23px;
  display: flex;
  justify-content: center;
  align-items: center;
}

.loading {
  width: 8px;
  height: 8px;
  border: 2px solid #cccccc;
  border-top-color: transparent;
  border-radius: 100%;
  animation: circle infinite 0.75s linear;
}

@keyframes circle {
  0% {
    transform: rotate(0);
  }

  100% {
    transform: rotate(360deg);
  }
}
</style>
