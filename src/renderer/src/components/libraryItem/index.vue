<script setup lang="ts">
import { ref, computed, watch, shallowRef } from 'vue'
import libraryItem from '@renderer/components/libraryItem/index.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import listIconAsset from '@renderer/assets/listIcon.svg?asset'
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
import type { IDir } from '../../../../types/globals'
const listIcon = listIconAsset
const listIconMaskStyle = {
  '--icon-mask': `url("${listIcon}")`
}
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

const dirDataRef = shallowRef<IDir | null>(null)
const fatherDirDataRef = shallowRef<IDir | null>(null)

const syncNodeRefs = () => {
  dirDataRef.value = libraryUtils.getLibraryTreeByUUID(props.uuid)
  fatherDirDataRef.value = libraryUtils.getFatherLibraryTreeByUUID(props.uuid)
}
syncNodeRefs()

watch(
  () => props.uuid,
  () => {
    syncNodeRefs()
  }
)
watch(
  () => runtime.libraryTree,
  () => {
    syncNodeRefs()
  },
  { deep: false }
)

const dirData = computed(() => dirDataRef.value)

const isSongList = computed(() => dirData.value?.type === 'songList')
const isMixtapeList = computed(() => dirData.value?.type === 'mixtapeList')
const isPlaylist = computed(() => isSongList.value || isMixtapeList.value)
const resolveMixtapeModeTag = (mixMode?: string) =>
  mixMode === 'eq' ? t('mixtape.mixModeEqTag') : t('mixtape.mixModeStemTag')
const resolveMixtapeModeLabel = (mixMode?: string) =>
  mixMode === 'eq' ? t('mixtape.mixModeEqLabel') : t('mixtape.mixModeStemLabel')
const resolveMixtapeBadgeTitle = (mixMode?: string) => resolveMixtapeModeLabel(mixMode)

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
} = useLibraryItemEditing({ dirDataRef, fatherDirDataRef, runtime, props, emitter })

const { trackCount } = useLibraryTrackCount({ runtime, dirDataRef, props })

const dirChildShow = ref(false)
const dirChildRendered = ref(false)

const { rightClickMenuShow, menuArr, contextmenuEvent, deleteDir } = useLibraryContextMenu({
  dirDataRef,
  fatherDirDataRef,
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
  dirDataRef,
  fatherDirDataRef,
  deleteDir,
  props,
  handleDropToSongList,
  emitter
})

const { shouldShow } = useLibraryFilter({
  props,
  dirDataRef,
  dirChildRendered,
  dirChildShow
})

const dirHandleClick = async () => {
  const currentDirData = dirDataRef.value
  if (!currentDirData) return
  if (runtime.songDragSuppressClickUntilMs > Date.now()) return
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
  if (isPlaylist.value) {
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
const syncIndentWidth = () => {
  const depth = libraryUtils.getDepthByUuid(props.uuid)
  indentWidth.value = typeof depth === 'number' ? (depth - 2) * 10 : 0
}
syncIndentWidth()
watch(
  () => props.uuid,
  () => {
    syncIndentWidth()
  }
)
watch(
  () => runtime.libraryTree,
  () => {
    syncIndentWidth()
  },
  { deep: false }
)

let isPlaying = ref(false)
watch(
  () => [runtime.playingData.playingSongListUUID, runtime.libraryTree],
  () => {
    if (!runtime.playingData.playingSongListUUID) {
      isPlaying.value = false
      return
    }
    let libraryTree = libraryUtils.getLibraryTreeByUUID(props.uuid)
    if (libraryTree === null) {
      isPlaying.value = false
      return
    }
    let uuids = libraryUtils.getAllUuids(libraryTree)
    if (uuids.indexOf(runtime.playingData.playingSongListUUID) != -1) {
      isPlaying.value = true
    } else {
      isPlaying.value = false
    }
  },
  { immediate: true }
)

const displayDirName = computed(() => {
  const d = dirData.value
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
const showTrackCount = computed(
  () =>
    dirData.value?.type === 'songList' &&
    runtime.setting.showPlaylistTrackCount &&
    trackCount.value !== null
)
const nameTextRef = ref<HTMLElement | null>(null)
const nameTextHovered = ref(false)
const onlyShowBubbleWhenOverflow = computed(
  () => !Boolean(Reflect.get(runtime.setting, 'songListBubbleAlways'))
)
const openMixtapeHandleClick = () => {
  const currentDirData = dirDataRef.value
  if (!currentDirData || currentDirData.type !== 'mixtapeList') return
  const playlistPath = libraryUtils.findDirPathByUuid(props.uuid)
  window.electron.ipcRenderer.send('mixtape:open', {
    playlistId: props.uuid,
    playlistPath,
    playlistName: currentDirData.dirName
  })
}
</script>
<template>
  <div
    v-if="dirData"
    v-show="shouldShow"
    class="mainBody"
    style="display: flex; box-sizing: border-box"
    :style="'padding-left:' + indentWidth + 'px'"
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
    @contextmenu.stop="contextmenuEvent"
    @click.stop="dirHandleClick()"
    @dragover.stop.prevent="dragover"
    @dragstart.stop="dragstart"
    @dragenter.stop.prevent="dragenter"
    @drop.stop.prevent="drop"
    @dragleave.stop="dragleave"
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
      <span
        v-if="
          isPlaylist &&
          runtime.importingSongListUUID != props.uuid &&
          runtime.creatingSongListUUID !== props.uuid
        "
        class="library-list-icon"
        :class="{ 'is-playing': isPlaying }"
        :style="listIconMaskStyle"
      ></span>
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
        <span
          ref="nameTextRef"
          :class="[
            'nameText',
            {
              'nameText--with-count': showTrackCount,
              'nameText--with-mixtape-action': dirData.type === 'mixtapeList'
            }
          ]"
          @mouseenter="isPlaylist && (nameTextHovered = true)"
          @mouseleave="nameTextHovered = false"
          >{{ nameForDisplay }}</span
        >
        <bubbleBox
          v-if="isPlaylist && nameTextHovered && nameForDisplay"
          :dom="nameTextRef || undefined"
          :title="nameForDisplay"
          :only-when-overflow="onlyShowBubbleWhenOverflow"
        />
        <span
          v-if="dirData.type === 'mixtapeList' || showTrackCount"
          class="rowActions"
          @click.stop
        >
          <span
            v-if="dirData.type === 'mixtapeList'"
            class="mixModeBadge"
            :class="{
              'is-eq': dirData.mixMode === 'eq',
              'is-stem': dirData.mixMode !== 'eq',
              isPlaying: isPlaying
            }"
            :title="resolveMixtapeBadgeTitle(dirData.mixMode)"
          >
            <span>{{ resolveMixtapeModeTag(dirData.mixMode) }}</span>
          </span>
          <button
            v-if="dirData.type === 'mixtapeList'"
            type="button"
            class="recordButton"
            :class="{ isPlaying: isPlaying }"
            :title="t('mixtape.openRecordWindow')"
            draggable="false"
            @mousedown.stop
            @click.stop="openMixtapeHandleClick"
            @dragstart.stop.prevent
            @contextmenu.stop
          >
            {{ t('mixtape.recordButton') }}
          </button>
          <span
            v-if="showTrackCount"
            class="countBadge"
            :class="{ isPlaying: isPlaying }"
            :title="t('tracks.title')"
            >{{ trackCount }}</span
          >
        </span>
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
    v-if="dirData && dirData.type == 'dir' && dirChildRendered"
    v-show="dirChildShow"
    style="width: 100%; box-sizing: border-box"
  >
    <template v-for="item of dirData.children" :key="item.uuid">
      <libraryItem
        :uuid="item.uuid"
        :library-name="props.libraryName"
        :filter-text="props.filterText"
      />
    </template>
  </div>
</template>
<style lang="scss" scoped>
.library-list-icon {
  width: 13px;
  height: 13px;
  display: inline-block;
  background-color: currentColor;
  color: var(--text);
  mask-image: var(--icon-mask);
  mask-repeat: no-repeat;
  mask-position: center;
  mask-size: contain;
  -webkit-mask-image: var(--icon-mask);
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  -webkit-mask-size: contain;
}
.library-list-icon.is-playing {
  color: var(--accent);
}

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
  padding-right: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nameText--with-count {
  padding-right: 42px;
}

.nameText--with-mixtape-action {
  padding-right: 116px;
}

.rowActions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
}

.mixModeBadge {
  width: 50px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-sizing: border-box;
}

.mixModeBadge.is-eq {
  background-color: rgba(255, 184, 77, 0.18);
  color: #d98300;
}

.mixModeBadge.is-stem {
  background-color: rgba(91, 173, 255, 0.18);
  color: #2f85d8;
}

.isPlaying.mixModeBadge {
  background-color: var(--accent);
  color: #ffffff !important;
}

.recordButton {
  height: 18px;
  min-width: 36px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--border) 85%, transparent);
  border-radius: 9px;
  background-color: color-mix(in srgb, var(--bg-elev) 92%, transparent);
  color: var(--text-weak);
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.recordButton:hover {
  background-color: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}

.recordButton:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, #ffffff);
  outline-offset: 1px;
}

.recordButton.isPlaying {
  border-color: color-mix(in srgb, var(--accent) 78%, transparent);
  color: var(--accent);
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
