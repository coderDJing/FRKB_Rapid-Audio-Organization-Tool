<script setup lang="ts">
import { ref, computed, onUnmounted, onMounted, useTemplateRef } from 'vue'
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

type Mode = 'scan' | 'drop'

const uuid = uuidV4()
const props = defineProps({
  mode: { type: String as () => Mode, required: true },
  libraryName: { type: String, default: 'FilterLibrary' },
  songListUuid: { type: String },
  confirmCallback: { type: Function, required: true },
  cancelCallback: { type: Function, required: true }
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

const folderPathVal = ref<string[]>([]) // 仅 scan 模式下使用
let clickChooseDirFlag = false
const clickChooseDir = async () => {
  if (clickChooseDirFlag || props.mode !== 'scan') return
  clickChooseDirFlag = true
  const folderPath = await window.electron.ipcRenderer.invoke('select-folder')
  clickChooseDirFlag = false
  if (folderPath) {
    folderPathVal.value = folderPath
  }
}

const folderPathDisplay = computed(() => {
  let newPaths = folderPathVal.value.map((path) => {
    let parts = path.split('\\')
    return parts[parts.length - 1] ? parts[parts.length - 1] : parts[parts.length - 2]
  })
  let str = [] as string[]
  for (let item of newPaths) {
    str.push('"' + item + '"')
  }
  return str.join(',')
})

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

const emits = defineEmits(['cancel'])

const flashArea = ref('') // 控制动画是否正在播放
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

const songListSelectedDisplay = computed(() => {
  let arr = songListSelected.value.split('\\')
  if (arr[0]) arr[0] = toLibraryDisplayName(arr[0])
  return arr.join('\\')
})

const confirm = () => {
  if (props.mode === 'scan') {
    if (folderPathVal.value.length === 0) {
      if (!flashArea.value) flashBorder('folderPathVal')
      return
    }
  }
  if (!songListSelected.value) {
    if (!flashArea.value) flashBorder('songListPathVal')
    return
  }

  if (props.mode === 'scan') {
    runtime.importingSongListUUID = importingSongListUUID
    runtime.isProgressing = true
    window.electron.ipcRenderer.send('startImportSongs', {
      folderPath: JSON.parse(JSON.stringify(folderPathVal.value)),
      songListPath: songListSelectedPath,
      isDeleteSourceFile: settingData.value.isDeleteSourceFile,
      isComparisonSongFingerprint: settingData.value.isComparisonSongFingerprint,
      isPushSongFingerprintLibrary: settingData.value.isPushSongFingerprintLibrary,
      songListUUID: importingSongListUUID
    })
    localStorage.setItem('scanNewSongDialog', JSON.stringify(settingData.value))
    ;(props.confirmCallback as Function)()
  } else if (props.mode === 'drop') {
    localStorage.setItem('scanNewSongDialog', JSON.stringify(settingData.value))
    ;(props.confirmCallback as Function)({
      importingSongListUUID: importingSongListUUID,
      songListPath: songListSelectedPath,
      isDeleteSourceFile: settingData.value.isDeleteSourceFile,
      isComparisonSongFingerprint: settingData.value.isComparisonSongFingerprint,
      isPushSongFingerprintLibrary: settingData.value.isPushSongFingerprintLibrary
    })
  }
}

const cancel = () => {
  localStorage.setItem('scanNewSongDialog', JSON.stringify(settingData.value))
  ;(props.cancelCallback as Function)()
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
            t('library.importNewTracks', { libraryType: toLibraryDisplayName(props.libraryName) })
          }}</span>
        </div>
        <div style="padding-left: 20px; padding-top: 30px; padding-right: 20px">
          <div class="settingsTable">
            <div v-if="props.mode === 'scan'" class="settingsRow">
              <div class="settingLabel">
                <span>{{ t('library.selectFolder') }}：</span>
              </div>
              <div class="settingCell">
                <div
                  class="chooseDirDiv flashing-border"
                  style="width: 100%"
                  @click="clickChooseDir()"
                  :title="folderPathDisplay"
                  :class="{ 'is-flashing': flashArea == 'folderPathVal' }"
                >
                  {{ folderPathDisplay }}
                </div>
              </div>
            </div>
            <div class="settingsRow">
              <div class="settingLabel">
                <span>{{ t('library.selectPlaylist') }}：</span>
              </div>
              <div class="settingCell">
                <div
                  class="chooseDirDiv flashing-border"
                  style="width: 100%"
                  @click="clickChooseSongList()"
                  :title="songListSelectedDisplay"
                  :class="{ 'is-flashing': flashArea == 'songListPathVal' }"
                >
                  {{ songListSelectedDisplay }}
                </div>
              </div>
            </div>
          </div>

          <div class="settingsTable" style="margin-top: 10px">
            <div class="settingsRow">
              <div class="settingLabel">
                <span>{{ t('library.deleteAfterImport') }}：</span>
              </div>
              <div class="settingCell">
                <div
                  style="
                    width: 20px;
                    height: 20px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                  "
                >
                  <singleCheckbox v-model="settingData.isDeleteSourceFile" />
                </div>
              </div>
            </div>
            <div class="settingsRow">
              <div class="settingLabel">
                <span>{{ t('library.deduplicateFingerprints') }}：</span>
              </div>
              <div class="settingCell" style="display: flex; align-items: center">
                <div
                  style="
                    width: 20px;
                    height: 20px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                  "
                >
                  <singleCheckbox v-model="settingData.isComparisonSongFingerprint" />
                </div>
                <div style="height: 20px; display: flex; align-items: center; padding-left: 3px">
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
            </div>
            <div class="settingsRow">
              <div class="settingLabel">
                <span>{{ t('library.addToFingerprintLibrary') }}：</span>
              </div>
              <div class="settingCell" style="display: flex; align-items: center">
                <div
                  style="
                    width: 20px;
                    height: 20px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                  "
                >
                  <singleCheckbox v-model="settingData.isPushSongFingerprintLibrary" />
                </div>
                <div style="height: 20px; display: flex; align-items: center; padding-left: 3px">
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
  height: 20px;
  background-color: #313131;
  text-overflow: ellipsis;
  overflow: hidden;
  word-break: break-all;
  white-space: nowrap;
  width: calc(100% - 5px);
  font-size: 14px;
  padding-left: 5px;
  line-height: 20px;
}

.formLabel {
  width: 110px;
  min-width: 110px;
  text-align: right;
  font-size: 14px;
  line-height: 20px;
  display: inline-flex;
  align-items: center;
}

/* 已统一 label 为右对齐，这里移除遗留类 */

.settingLabel {
  display: table-cell;
  text-align: right;
  font-size: 14px;
  white-space: nowrap;
  padding-right: 8px;
  height: 20px;
  line-height: 20px;
  vertical-align: middle;
}

.settingsTable {
  display: table;
  width: 100%;
  border-collapse: separate;
  border-spacing: 0 10px;
}

.settingsRow {
  display: table-row;
}

.settingCell {
  display: table-cell;
  width: 100%;
  height: 20px;
  vertical-align: middle;
}
</style>
