<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, computed, ComputedRef, useTemplateRef } from 'vue'
import rightClickMenu from '@renderer/components/rightClickMenu'
import dialogLibraryItem from '@renderer/components/dialogLibraryItem/index.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils'
import { v4 as uuidV4 } from 'uuid'
import confirm from '@renderer/components/confirmDialog'
import hotkeys from 'hotkeys-js'
import listIcon from '@renderer/assets/listIcon.png?asset'
import utils, { getCurrentTimeDirName } from '../utils/utils'
import { t, toLibraryDisplayName } from '@renderer/utils/translate'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import emitter from '../utils/mitt'
import type { IDir } from 'src/types/globals'
import { handleLibraryAreaEmptySpaceDrop } from '../utils/dragUtils'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'

const uuid = uuidV4()
const props = defineProps({
  libraryName: {
    type: String,
    default: '筛选库'
  }
})

const runtime = useRuntimeStore()
runtime.activeMenuUUID = ''
runtime.selectSongListDialogShow = true
let recentDialogSelectedSongListUUID: string[] = []
let localStorageRecentDialogSelectedSongListUUID = localStorage.getItem(
  'recentDialogSelectedSongListUUID' + props.libraryName
)
if (localStorageRecentDialogSelectedSongListUUID) {
  recentDialogSelectedSongListUUID = JSON.parse(localStorageRecentDialogSelectedSongListUUID)
  // 按设置的最大缓存数量裁剪本地缓存
  const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount ?? 10
  if (recentDialogSelectedSongListUUID.length > maxCount) {
    recentDialogSelectedSongListUUID = recentDialogSelectedSongListUUID.slice(0, maxCount)
    localStorage.setItem(
      'recentDialogSelectedSongListUUID' + props.libraryName,
      JSON.stringify(recentDialogSelectedSongListUUID)
    )
  }
}
let index = 0
if (recentDialogSelectedSongListUUID.length !== 0) {
  runtime.dialogSelectedSongListUUID = recentDialogSelectedSongListUUID[index]
}

const recentSongListArr = ref<IDir[]>([])
let delRecentDialogSelectedSongListUUID: string[] = []
watch(
  () => runtime.libraryTree,
  () => {
    recentSongListArr.value = []
    delRecentDialogSelectedSongListUUID = []
    for (let uuid of recentDialogSelectedSongListUUID) {
      let obj = libraryUtils.getLibraryTreeByUUID(uuid)
      if (obj === null) {
        delRecentDialogSelectedSongListUUID.push(uuid)
      }
      if (obj) {
        recentSongListArr.value.push(obj)
      }
    }
    if (delRecentDialogSelectedSongListUUID.length !== 0) {
      recentDialogSelectedSongListUUID = recentDialogSelectedSongListUUID.filter(
        (item) => delRecentDialogSelectedSongListUUID.indexOf(item) === -1
      )
      localStorage.setItem(
        'recentDialogSelectedSongListUUID' + props.libraryName,
        JSON.stringify(recentDialogSelectedSongListUUID)
      )
    }
  },
  { deep: true, immediate: true }
)

const libraryData: ComputedRef<IDir> = computed(() => {
  let filtrateLibraryUUID: string | undefined
  if (runtime.libraryTree && runtime.libraryTree.children) {
    filtrateLibraryUUID = runtime.libraryTree.children.find(
      (element) => element.type === 'library' && element.dirName === props.libraryName
    )?.uuid
  }
  if (filtrateLibraryUUID === undefined) {
    throw new Error(`filtrateLibraryUUID error for libraryName ${props.libraryName}`)
  }
  let data = libraryUtils.getLibraryTreeByUUID(filtrateLibraryUUID)
  if (data === null) {
    throw new Error(`libraryData error: could not find library with UUID ${filtrateLibraryUUID}`)
  }
  return data
})

const collapseButtonRef = useTemplateRef<HTMLDivElement>('collapseButtonRef')

const libraryTitleText = computed(() => toLibraryDisplayName(libraryData.value.dirName))

const menuArr = ref([
  [{ menuName: 'library.createPlaylist' }, { menuName: 'library.createFolder' }]
])
const contextmenuEvent = async (event: MouseEvent) => {
  if (!libraryData.value) return
  let result = await rightClickMenu({ menuArr: menuArr.value, clickEvent: event })
  if (result !== 'cancel') {
    if (result.menuName == 'library.createPlaylist') {
      libraryData.value.children?.unshift({
        uuid: uuidV4(),
        type: 'songList',
        dirName: ''
      })
    } else if (result.menuName == 'library.createFolder') {
      libraryData.value.children?.unshift({
        uuid: uuidV4(),
        type: 'dir',
        dirName: ''
      })
    }
  }
}

const collapseButtonHandleClick = async () => {
  if (!libraryData.value) return
  emitter.emit('collapseButtonHandleClick', libraryData.value.dirName + 'Dialog')
}

const dragover = (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  e.dataTransfer.dropEffect = 'move'
}
const dragenter = (e: DragEvent) => {
  if (e.dataTransfer === null) {
    throw new Error(`e.dataTransfer error: ${JSON.stringify(e.dataTransfer)}`)
  }
  if (runtime.dragItemData === null) {
    e.dataTransfer.dropEffect = 'none'
    return
  }
  e.dataTransfer.dropEffect = 'move'
}
const dragleave = () => {
  if (runtime.dragItemData === null) {
    return
  }
}
const drop = async () => {
  if (runtime.dragItemData === null || !libraryData.value) {
    return
  }
  try {
    const handled = await handleLibraryAreaEmptySpaceDrop(runtime.dragItemData, libraryData.value)
  } catch (error) {
    console.error('Drop operation failed:', error)
  } finally {
    runtime.dragItemData = null
  }
}
onMounted(() => {
  hotkeys('s', uuid, () => {
    if (recentDialogSelectedSongListUUID.length !== 0) {
      index++
      if (index === recentDialogSelectedSongListUUID.length) {
        index = 0
      }
      runtime.dialogSelectedSongListUUID = recentDialogSelectedSongListUUID[index]
    }
  })
  hotkeys('w', uuid, () => {
    if (recentDialogSelectedSongListUUID.length !== 0) {
      index--
      if (index === -1) {
        index = recentDialogSelectedSongListUUID.length - 1
      }
      runtime.dialogSelectedSongListUUID = recentDialogSelectedSongListUUID[index]
    }
  })
  hotkeys('E', uuid, () => {
    confirmHandle()
  })
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
})
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  runtime.dialogSelectedSongListUUID = ''
  runtime.selectSongListDialogShow = false
})

const flashArea = ref('')
const flashBorder = (flashAreaName: string) => {
  flashArea.value = flashAreaName
  let count = 0
  const interval = setInterval(() => {
    count++
    if (count >= 3) {
      clearInterval(interval)
      flashArea.value = ''
    }
  }, 500)
}
const confirmHandle = () => {
  if (
    runtime.dialogSelectedSongListUUID === '' ||
    libraryUtils.getLibraryTreeByUUID(runtime.dialogSelectedSongListUUID) === null
  ) {
    if (!flashArea.value) {
      flashBorder('selectSongList')
    }
  } else {
    if (recentDialogSelectedSongListUUID.indexOf(runtime.dialogSelectedSongListUUID) === -1) {
      recentDialogSelectedSongListUUID.unshift(runtime.dialogSelectedSongListUUID)
      const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount ?? 10
      while (recentDialogSelectedSongListUUID.length > maxCount) {
        recentDialogSelectedSongListUUID.pop()
      }
    } else {
      recentDialogSelectedSongListUUID.unshift(
        recentDialogSelectedSongListUUID.splice(
          recentDialogSelectedSongListUUID.indexOf(runtime.dialogSelectedSongListUUID),
          1
        )[0]
      )
      const maxCount = runtime.setting.recentDialogSelectedSongListMaxCount ?? 10
      while (recentDialogSelectedSongListUUID.length > maxCount) {
        recentDialogSelectedSongListUUID.pop()
      }
    }
    localStorage.setItem(
      'recentDialogSelectedSongListUUID' + props.libraryName,
      JSON.stringify(recentDialogSelectedSongListUUID)
    )
    emits('confirm', runtime.dialogSelectedSongListUUID)
  }
}
const emits = defineEmits(['cancel', 'confirm'])
const cancel = () => {
  emits('cancel')
}
</script>
<template>
  <div class="dialog unselectable">
    <div class="content inner" @contextmenu.stop="contextmenuEvent">
      <div class="unselectable libraryTitle" v-if="libraryData">
        <span>{{ libraryTitleText }}</span>
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
          <bubbleBox
            :dom="collapseButtonRef || undefined"
            :title="t('playlist.collapsibleFolder')"
          />
        </div>
      </div>
      <div
        class="unselectable libraryArea flashing-border"
        :class="{ 'is-flashing': flashArea == 'selectSongList' }"
        v-if="libraryData?.children?.length"
      >
        <OverlayScrollbarsComponent
          :options="{
            scrollbars: {
              autoHide: 'leave',
              autoHideDelay: 50,
              clickScroll: true
            },
            overflow: {
              x: 'hidden',
              y: 'scroll'
            }
          }"
          element="div"
          style="height: 100%; width: 100%"
          defer
        >
          <template v-if="recentSongListArr.length > 0">
            <div style="padding-left: 5px">
              <span style="font-size: 14px">{{ t('library.recentlyUsed') }}</span>
            </div>
            <div style="width: 100%; background-color: #8c8c8c; height: 1px">
              <div style="height: 1px"></div>
            </div>
            <div
              v-for="item of recentSongListArr"
              :key="item.uuid"
              @click="runtime.dialogSelectedSongListUUID = item.uuid"
              @dblclick="confirmHandle()"
              :class="{ selectedDir: item.uuid == runtime.dialogSelectedSongListUUID }"
              class="recentLibraryItem"
            >
              <div style="width: 20px; justify-content: center; align-items: center; display: flex">
                <img style="width: 13px; height: 13px" :src="listIcon" />
              </div>
              <div>
                {{ item.dirName }}
              </div>
            </div>
            <div style="width: 100%; background-color: #8c8c8c; height: 1px">
              <div style="height: 1px"></div>
            </div>
          </template>
          <template v-for="item of libraryData?.children" :key="item.uuid">
            <dialogLibraryItem
              :uuid="item.uuid"
              :libraryName="libraryData.dirName + 'Dialog'"
              @dblClickSongList="confirmHandle()"
            />
          </template>
          <div
            style="flex-grow: 1; min-height: 30px"
            @dragover.stop.prevent="dragover"
            @dragenter.stop.prevent="dragenter"
            @drop.stop="drop"
            @dragleave.stop="dragleave"
          ></div>
        </OverlayScrollbarsComponent>
      </div>
      <div
        class="unselectable flashing-border"
        :class="{ 'is-flashing': flashArea == 'selectSongList' }"
        v-else
        style="
          max-width: 300px;
          display: flex;
          justify-content: center;
          align-items: center;
          flex-grow: 1;
          min-height: 0;
        "
      >
        <span style="font-size: 12px; color: #8c8c8c">{{ t('library.rightClickToCreate') }}</span>
      </div>

      <div style="display: flex; justify-content: center; padding-bottom: 10px">
        <div
          class="button"
          style="margin-right: 10px; width: 90px; text-align: center"
          @click="confirmHandle()"
        >
          {{ t('common.confirm') }} (E)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="cancel()">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.recentLibraryItem {
  display: flex;

  height: 23px;
  align-items: center;
  font-size: 13px;

  &:hover {
    background-color: #2a2d2e;
  }
}

.selectedDir {
  background-color: #37373d;

  &:hover {
    background-color: #37373d !important;
  }
}

.libraryArea {
  max-width: 300px;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  flex-grow: 1;
  min-height: 0; // 防止内容过多时溢出 flex 容器
}

.content {
  height: 500px;
  width: 300px;
  max-width: 300px;
  display: flex;
  flex-grow: 1;
  background-color: #181818;
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
      color: #cccccc;
      width: 20px;
      height: 20px;
      display: flex;
      justify-content: center;
      align-items: center;

      border-radius: 5px;

      &:hover {
        background-color: #2d2e2e;
      }
    }
  }
}

.bubbleBox {
  height: 22px;
  line-height: 22px;
  text-align: center;
  position: relative;
  border-radius: 3px;
  border: 1px solid #424242;
  font-size: 12px;
  background-color: #202020;
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
