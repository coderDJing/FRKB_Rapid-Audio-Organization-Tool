<script setup lang="ts">
import { ref, onUnmounted, onMounted, computed, useTemplateRef } from 'vue'
import singleCheckbox from './singleCheckbox.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import selectSongListDialog from './selectSongListDialog.vue'
import libraryUtils from '@renderer/utils/libraryUtils'
import hintIcon from '@renderer/assets/hint.png?asset'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '../utils/utils'
import { t, toLibraryDisplayName } from '@renderer/utils/translate'
const uuid = uuidV4()
const props = defineProps({
  songListUuid: {
    type: String
  },
  libraryName: {
    type: String,
    default: '筛选库'
  },
  confirmCallback: {
    type: Function,
    required: true
  },
  cancelCallback: {
    type: Function,
    required: true
  }
})
type SettingData = {
  isDeleteSourceFile: boolean
  isComparisonSongFingerprint: boolean
  isPushSongFingerprintLibrary: boolean
}
const settingData = ref<SettingData>({
  isDeleteSourceFile: true,
  isComparisonSongFingerprint: true,
  isPushSongFingerprintLibrary: true
})
let localStorageData = localStorage.getItem('scanNewSongDialog')
if (localStorageData == null) {
  localStorage.setItem(
    'scanNewSongDialog',
    JSON.stringify({
      isDeleteSourceFile: true,
      isComparisonSongFingerprint: true,
      isPushSongFingerprintLibrary: true
    })
  )
  localStorageData = JSON.stringify({
    isDeleteSourceFile: true,
    isComparisonSongFingerprint: true,
    isPushSongFingerprintLibrary: true
  })
}
const parsedLocalStorageData = JSON.parse(localStorageData) as SettingData
settingData.value = parsedLocalStorageData

const runtime = useRuntimeStore()

runtime.activeMenuUUID = ''

const emits = defineEmits(['cancel'])

const flashArea = ref('') // 控制动画是否正在播放

// 模拟闪烁三次的逻辑（使用 setTimeout）
const flashBorder = (flashAreaName: string) => {
  flashArea.value = flashAreaName
  let count = 0
  const interval = setInterval(() => {
    count++
    if (count >= 3) {
      clearInterval(interval)
      flashArea.value = '' // 动画结束，不再闪烁
    }
  }, 500) // 每次闪烁间隔 500 毫秒
}

const songListSelected = ref('')
const selectSongListDialogShow = ref(false)
const clickChooseSongList = () => {
  selectSongListDialogShow.value = true
}
let songListSelectedPath = ''
let importingSongListUUID = ''
if (props.songListUuid) {
  importingSongListUUID = props.songListUuid
  let dirPath = libraryUtils.findDirPathByUuid(props.songListUuid)
  if (dirPath === null) {
    throw new Error(`dirPath error: ${JSON.stringify(dirPath)}`)
  }
  songListSelectedPath = dirPath
  let songListSelectedPathArr = songListSelectedPath.split('/')
  songListSelectedPathArr.shift()
  songListSelected.value = songListSelectedPathArr.join('\\')
}

const selectSongListDialogConfirm = (uuid: string) => {
  importingSongListUUID = uuid
  let dirPath = libraryUtils.findDirPathByUuid(uuid)
  if (dirPath === null) {
    throw new Error(`dirPath error: ${JSON.stringify(dirPath)}`)
  }
  songListSelectedPath = dirPath
  let songListSelectedPathArr = dirPath.split('/')
  songListSelectedPathArr.shift()
  songListSelected.value = songListSelectedPathArr.join('\\')
  selectSongListDialogShow.value = false
}

const confirm = () => {
  if (!songListSelected.value) {
    if (!flashArea.value) {
      flashBorder('songListPathVal')
    }
    return
  }
  localStorage.setItem('scanNewSongDialog', JSON.stringify(settingData.value))
  props.confirmCallback({
    importingSongListUUID: importingSongListUUID,
    songListPath: songListSelectedPath,
    isDeleteSourceFile: settingData.value.isDeleteSourceFile,
    isComparisonSongFingerprint: settingData.value.isComparisonSongFingerprint,
    isPushSongFingerprintLibrary: settingData.value.isPushSongFingerprintLibrary
  })
}
const cancel = () => {
  localStorage.setItem('scanNewSongDialog', JSON.stringify(settingData.value))
  props.cancelCallback()
}
const hint1Ref = useTemplateRef<HTMLImageElement>('hint1Ref')
const hint2Ref = useTemplateRef<HTMLImageElement>('hint2Ref')
onMounted(() => {
  hotkeys('E', uuid, () => {
    confirm()
  })
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})

const songListSelectedDisplay = computed(() => {
  let arr = songListSelected.value.split('\\')
  arr[0] = toLibraryDisplayName(arr[0])
  return arr.join('\\')
})
</script>
<template>
  <div class="dialog unselectable">
    <div
      style="
        width: 450px;
        height: 300px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      "
      class="inner"
    >
      <div>
        <div style="text-align: center; height: 30px; line-height: 30px; font-size: 14px">
          <span style="font-weight: bold">{{
            t('library.importNewTracks', { libraryType: t(props.libraryName) })
          }}</span>
        </div>
        <div style="padding-left: 20px; padding-top: 30px; padding-right: 20px">
          <div style="margin-top: 10px; display: flex">
            <div class="formLabel">
              <span>{{ t('library.selectPlaylist') }}：</span>
            </div>

            <div style="width: 300px">
              <div
                class="chooseDirDiv flashing-border"
                @click="clickChooseSongList()"
                :title="songListSelectedDisplay"
                :class="{ 'is-flashing': flashArea == 'songListPathVal' }"
              >
                {{ songListSelectedDisplay }}
              </div>
            </div>
          </div>
          <div style="margin-top: 30px; display: flex">
            <div class="formLabel settingLabel">
              <span>{{ t('library.deleteAfterImport') }}：</span>
            </div>
            <div style="width: 21px; height: 21px; display: flex; align-items: center">
              <singleCheckbox v-model="settingData.isDeleteSourceFile" />
            </div>
          </div>
          <div style="margin-top: 10px; display: flex">
            <div class="formLabel settingLabel">
              <span>{{ t('library.deduplicateFingerprints') }}：</span>
            </div>
            <div style="width: 21px; height: 21px; display: flex; align-items: center">
              <singleCheckbox v-model="settingData.isComparisonSongFingerprint" />
            </div>
            <div style="height: 21px; display: flex; align-items: center; padding-left: 3px">
              <img
                ref="hint1Ref"
                :src="hintIcon"
                style="width: 15px; height: 15px"
                :draggable="false"
              />
              <bubbleBox
                :dom="hint1Ref || undefined"
                :title="t('library.deduplicateHint')"
                :maxWidth="220"
              />
            </div>
          </div>
          <div style="margin-top: 10px; display: flex">
            <div class="formLabel settingLabel">
              <span>{{ t('library.addToFingerprintLibrary') }}：</span>
            </div>
            <div style="width: 21px; height: 21px; display: flex; align-items: center">
              <singleCheckbox v-model="settingData.isPushSongFingerprintLibrary" />
            </div>
            <div style="height: 21px; display: flex; align-items: center; padding-left: 3px">
              <img
                ref="hint2Ref"
                :src="hintIcon"
                style="width: 15px; height: 15px"
                :draggable="false"
              />
              <bubbleBox
                :dom="hint2Ref || undefined"
                :title="t('library.fingerprintHint')"
                :maxWidth="240"
              />
            </div>
          </div>
        </div>
      </div>

      <div style="display: flex; justify-content: center; padding-bottom: 10px">
        <div
          class="button"
          style="margin-right: 10px; width: 90px; text-align: center"
          @click="confirm()"
        >
          {{ t('common.confirm') }} (E)
        </div>
        <div class="button" @click="cancel()" style="width: 90px; text-align: center">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
  <selectSongListDialog
    v-if="selectSongListDialogShow"
    :libraryName="props.libraryName"
    @confirm="selectSongListDialogConfirm"
    @cancel="
      () => {
        selectSongListDialogShow = false
      }
    "
  />
</template>
<style lang="scss" scoped>
.chooseDirDiv {
  width: calc(100% - 5px);
  height: 100%;
  background-color: #313131;

  text-overflow: ellipsis;
  overflow: hidden;
  word-break: break-all;
  white-space: nowrap;
  width: calc(100% - 5px);
  font-size: 14px;
  padding-left: 5px;
}

.formLabel {
  width: 110px;
  min-width: 110px;
  text-align: left;
  font-size: 14px;
}

.settingLabel {
  width: fit-content;
  min-width: 150px;
  text-align: right;
}
</style>
