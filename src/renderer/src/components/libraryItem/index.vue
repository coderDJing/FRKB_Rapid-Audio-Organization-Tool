<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import libraryItem from '@renderer/components/libraryItem/index.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import listIcon from '@renderer/assets/listIcon.png?asset'
import listIconBlue from '@renderer/assets/listIconBlue.png?asset'
import libraryUtils from '@renderer/utils/libraryUtils'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import emitter from '../../utils/mitt'
import { useDragSongs } from '@renderer/pages/modules/songsArea/composables/useDragSongs'
import { useLibraryItemEditing } from './useLibraryItemEditing'
import { useLibraryContextMenu } from './useLibraryContextMenu'
import { useLibraryDragAndDrop } from './useLibraryDragAndDrop'
import { useLibraryTrackCount } from './useLibraryTrackCount'
import { useLibraryFilter } from './useLibraryFilter'
const props = defineProps({
  uuid: {
    type: String,
    required: true
  },
  libraryName: {
    type: String,
    required: true
  },
  // 歌单筛选关键词（仅匹配歌单名）
  filterText: {
    type: [String, Object],
    default: ''
  }
})
const runtime = useRuntimeStore()
const hasAcoustIdKey = computed(() => {
  const key = (runtime.setting?.acoustIdClientKey || '').trim()
  return key.length > 0
})
const hasWarnedAcoustId = ref(false)
const warnAcoustIdMissing = () => {
  if (hasAcoustIdKey.value || hasWarnedAcoustId.value) return
  hasWarnedAcoustId.value = true
  void confirm({
    title: t('metadata.autoFillFingerprintHintTitle'),
    content: [
      t('metadata.autoFillFingerprintHintMissing'),
      t('metadata.autoFillFingerprintHintGuide')
    ],
    confirmShow: false
  })
}
const { handleDropToSongList } = useDragSongs()

let dirData = libraryUtils.getLibraryTreeByUUID(props.uuid)
if (dirData === null) {
  throw new Error(`dirData error: ${JSON.stringify(dirData)}`)
}
let fatherDirData = libraryUtils.getFatherLibraryTreeByUUID(props.uuid)
if (fatherDirData === null) {
  throw new Error(`fatherDirData error: ${JSON.stringify(fatherDirData)}`)
}

const {
  operationInputValue,
  inputHintText,
  inputHintShow,
  myInput,
  myInputHandleInput,
  inputKeyDownEnter,
  inputKeyDownEsc,
  inputBlurHandle,
  renameDivShow,
  renameDivValue,
  myRenameInput,
  renameInputHintShow,
  renameInputHintText,
  renameInputBlurHandle,
  renameInputKeyDownEnter,
  renameInputKeyDownEsc,
  renameMyInputHandleInput,
  startRename
} = useLibraryItemEditing({ dirData, fatherDirData, runtime, props, emitter })

const { trackCount } = useLibraryTrackCount({ runtime, dirData, props })

const dirChildShow = ref(false)
const dirChildRendered = ref(false)

const { rightClickMenuShow, menuArr, contextmenuEvent, deleteDir } = useLibraryContextMenu({
  dirData,
  fatherDirData,
  runtime,
  props,
  emitter,
  dirChildRendered,
  dirChildShow,
  trackCount,
  warnAcoustIdMissing,
  startRename
})

const { dragApproach, dragstart, dragover, dragenter, dragleave, drop } = useLibraryDragAndDrop({
  runtime,
  dirData,
  fatherDirData,
  deleteDir,
  props,
  handleDropToSongList,
  emitter
})

const { shouldShow } = useLibraryFilter({
  props,
  dirData,
  dirChildRendered,
  dirChildShow
})

const dirHandleClick = async () => {
  runtime.activeMenuUUID = ''
  const songListPath = libraryUtils.findDirPathByUuid(props.uuid)
  const isSongListPathExist = await window.electron.ipcRenderer.invoke(
    'dirPathExists',
    songListPath
  )
  if (!isSongListPathExist) {
    await confirm({
      title: t('common.error'),
      content: [t('library.notExistOnDisk')],
      confirmShow: false
    })
    await deleteDir()
    return
  }
  if (dirData.type === 'songList') {
    if (runtime.songsArea.songListUUID === props.uuid) {
      runtime.songsArea.songListUUID = ''
      return
    }
    runtime.songsArea.songListUUID = props.uuid
  } else {
    dirChildRendered.value = true
    dirChildShow.value = !dirChildShow.value
  }
}

emitter.on('collapseButtonHandleClick', (libraryName: string) => {
  if (libraryName == props.libraryName) {
    dirChildShow.value = false
  }
})

const indentWidth = ref(0)
let depth = libraryUtils.getDepthByUuid(props.uuid)
if (depth === undefined) {
  throw new Error(`depth error: ${JSON.stringify(depth)}`)
}
indentWidth.value = (depth - 2) * 10

let isPlaying = ref(false)
watch(
  () => runtime.playingData.playingSongListUUID,
  () => {
    if (!runtime.playingData.playingSongListUUID) {
      isPlaying.value = false
      return
    }
    let libraryTree = libraryUtils.getLibraryTreeByUUID(props.uuid)
    if (libraryTree === null) {
      throw new Error(`libraryTree error: ${JSON.stringify(libraryTree)}`)
    }
    let uuids = libraryUtils.getAllUuids(libraryTree)
    if (uuids.indexOf(runtime.playingData.playingSongListUUID) != -1) {
      isPlaying.value = true
    } else {
      isPlaying.value = false
    }
  }
)

const displayDirName = computed(() => {
  const d = dirData
  if (!d) return ''
  if (runtime.libraryAreaSelected === 'RecycleBin' && d.dirName) {
    // 支持分钟格式（无秒）与历史秒级格式
    const matchMinute = d.dirName.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})$/)
    if (matchMinute) {
      return `${matchMinute[1]}-${matchMinute[2]}-${matchMinute[3]} ${matchMinute[4]}:${matchMinute[5]}`
    }
    const matchSecond = d.dirName.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/)
    if (matchSecond) {
      return `${matchSecond[1]}-${matchSecond[2]}-${matchSecond[3]} ${matchSecond[4]}:${matchSecond[5]}:${matchSecond[6]}`
    }
  }
  if (
    d.type === 'songList' &&
    runtime.setting.showPlaylistTrackCount &&
    trackCount.value !== null
  ) {
    return d.dirName
  }
  return d.dirName
})

// 供模板使用的名称（不带数量）
const nameForDisplay = computed(() => displayDirName.value)
</script>
<template>
  <div
    class="mainBody"
    style="display: flex; box-sizing: border-box"
    :style="'padding-left:' + indentWidth + 'px'"
    @contextmenu.stop="contextmenuEvent"
    @click.stop="dirHandleClick()"
    @dragover.stop.prevent="dragover"
    @dragstart.stop="dragstart"
    @dragenter.stop.prevent="dragenter"
    @drop.stop.prevent="drop"
    @dragleave.stop="dragleave"
    v-show="shouldShow"
    :draggable="
      dirData.dirName && !renameDivShow && runtime.libraryAreaSelected !== 'RecycleBin'
        ? true
        : false
    "
    :class="{
      rightClickBorder: rightClickMenuShow,
      borderTop: dragApproach == 'top',
      borderBottom: dragApproach == 'bottom',
      borderCenter: dragApproach == 'center',
      selectedDir: props.uuid == runtime.songsArea.songListUUID
    }"
  >
    <div class="prefixIcon" :class="{ isPlaying: isPlaying }">
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
        v-if="
          dirData.type == 'songList' &&
          runtime.importingSongListUUID != props.uuid &&
          runtime.creatingSongListUUID !== props.uuid
        "
        style="width: 13px; height: 13px"
        :src="isPlaying ? listIconBlue : listIcon"
        :class="!isPlaying ? 'songlist-icon' : ''"
      />
      <div
        v-if="dirData.type == 'songList' && runtime.creatingSongListUUID === props.uuid"
        class="loading"
        :class="{ isPlayingLoading: isPlaying }"
      ></div>
      <div
        v-if="dirData.type == 'songList' && runtime.importingSongListUUID == props.uuid"
        class="loading"
        :class="{ isPlayingLoading: isPlaying }"
      ></div>
    </div>
    <div style="height: 23px; width: calc(100% - 20px)">
      <div
        v-if="dirData.dirName && !renameDivShow"
        class="nameRow"
        :class="{ isPlaying: isPlaying }"
      >
        <span class="nameText">{{ nameForDisplay }}</span>
        <span
          v-if="
            dirData.type === 'songList' &&
            runtime.setting.showPlaylistTrackCount &&
            trackCount !== null
          "
          class="countBadge"
          :class="{ isPlaying: isPlaying }"
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
      <libraryItem
        :uuid="item.uuid"
        :libraryName="props.libraryName"
        :filterText="(props as any).filterText"
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
  padding-right: 8px; // 右侧留白，避免贴边
  position: relative; // 让徽标绝对定位不受省略号影响
}

.nameText {
  flex: 1 1 auto;
  min-width: 0;
  padding-right: 48px; // 为绝对定位的徽标预留空间
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
  background-color: var(--hover);
  color: var(--text-weak);
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
}

.isPlaying.countBadge {
  background-color: var(--accent);
  color: #ffffff !important;
}
.isPlaying {
  color: var(--accent) !important;
}

.isPlayingLoading {
  border: 2px solid var(--accent) !important;
}

.loading {
  width: 8px;
  height: 8px;
  border: 2px solid var(--text);
  border-top-color: transparent;
  border-radius: 100%;
  animation: circle infinite 0.75s linear;
}

// 转转转动画
@keyframes circle {
  0% {
    transform: rotate(0);
  }

  100% {
    transform: rotate(360deg);
  }
}

.selectedDir {
  background-color: var(--hover);

  &:hover {
    background-color: var(--hover) !important;
  }
}

.mainBody {
  &:hover {
    background-color: var(--hover);
  }
}

.borderTop {
  box-shadow: inset 0 1px 0 0 var(--accent);
}

.borderBottom {
  box-shadow: inset 0 -1px 0 0 var(--accent);
}

.borderCenter {
  box-shadow: inset 0 0 0 1px var(--accent);
}

.rightClickBorder {
  box-shadow: inset 0 0 0 1px var(--accent);
}

.myInput {
  width: calc(100% - 6px);
  height: 19px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
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
    color: #ffffff;
    font-size: 12px;
    padding-left: 5px;
    position: relative;
    z-index: 100;
  }
}

.prefixIcon {
  color: var(--text);
  width: 20px;
  min-width: 20px;
  height: 23px;
  display: flex;
  justify-content: center;
  align-items: center;
}
</style>
