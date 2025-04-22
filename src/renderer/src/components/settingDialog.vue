<script setup lang="ts">
import { onUnmounted, onMounted, ref } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '../utils/utils'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import confirm from '@renderer/components/confirmDialog'
import globalCallShortcutDialog from './globalCallShortcutDialog'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
const runtime = useRuntimeStore()
const uuid = uuidV4()
const emits = defineEmits(['cancel'])
const cancel = () => {
  emits('cancel')
}

onMounted(() => {
  hotkeys('Esc', uuid, () => {
    cancel()
  })
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})

const setSetting = async () => {
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

type AudioExt = {
  mp3: boolean
  wav: boolean
  flac: boolean
}
const audioExt = ref<AudioExt>({
  mp3: runtime.setting.audioExt.indexOf('.mp3') != -1,
  wav: runtime.setting.audioExt.indexOf('.wav') != -1,
  flac: runtime.setting.audioExt.indexOf('.flac') != -1
})

let audioExtOld = JSON.parse(JSON.stringify(audioExt.value)) as AudioExt
const extChange = async () => {
  if (runtime.isProgressing) {
    audioExt.value = { ...audioExtOld }
    await confirm({
      title: '设置',
      content: [t('请等待当前任务执行结束')],
      confirmShow: false
    })
    return
  }
  audioExtOld = JSON.parse(JSON.stringify(audioExt.value))
  let audioExtArr = []
  for (let key in audioExt.value) {
    if (['mp3', 'wav', 'flac'].includes(key as 'mp3' | 'wav' | 'flac')) {
      if (audioExt.value[key as 'mp3' | 'wav' | 'flac']) {
        audioExtArr.push('.' + key)
      }
    }
  }
  runtime.setting.audioExt = audioExtArr
  setSetting()
}
const clearTracksFingerprintLibrary = async () => {
  if (runtime.isProgressing) {
    await confirm({
      title: '设置',
      content: [t('请等待当前任务执行结束')],
      confirmShow: false
    })
    return
  }
  let res = await confirm({
    title: '警告',
    content: [t('确定要清除当前曲目指纹库吗？')]
  })
  if (res === 'confirm') {
    await window.electron.ipcRenderer.invoke('clearTracksFingerprintLibrary')
    await confirm({
      title: '设置',
      content: [t('清除完成')],
      confirmShow: false
    })
  }
}

const globalCallShortcutHandle = async () => {
  await globalCallShortcutDialog()
}

const reSelectLibrary = async () => {
  if (runtime.isProgressing) {
    await confirm({
      title: '设置',
      content: [t('请等待当前任务执行结束')],
      confirmShow: false
    })
    return
  }
  let res = await confirm({
    title: '提示',
    content: [
      t('当前使用的数据库文件夹仍保留在原位置，可手动删除或重新选择继续使用。'),
      t('确认重新选择数据库所在位置？')
    ],
    confirmShow: true
  })
  if (res === 'confirm') {
    setSetting()
    await window.electron.ipcRenderer.invoke('reSelectLibrary')
  }
}

if (!runtime.setting.fastForwardTime) {
  runtime.setting.fastForwardTime = 10
}
if (!runtime.setting.fastBackwardTime) {
  runtime.setting.fastBackwardTime = -5
}
</script>
<template>
  <div class="dialog unselectable">
    <div
      style="
        width: 60vw;
        height: 70vh;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      "
      class="inner"
    >
      <div style="height: 100%; display: flex; flex-direction: column">
        <div style="text-align: center; height: 30px; line-height: 30px; font-size: 14px">
          <span style="font-weight: bold">{{ t('设置') }}</span>
        </div>
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
          <div style="padding: 20px; font-size: 14px; flex-grow: 1">
            <div>{{ t('语言') }}：</div>
            <div style="margin-top: 10px">
              <select v-model="runtime.setting.language" @change="setSetting">
                <option value="zhCN">简体中文</option>
                <option value="enUS">English</option>
              </select>
            </div>
            <div style="margin-top: 20px">{{ t('隐藏播放控制区域，显示更长的波形图') }}：</div>
            <div style="margin-top: 10px">
              <singleCheckbox
                v-model="runtime.setting.hiddenPlayControlArea"
                @change="extChange()"
              />
            </div>
            <div style="margin-top: 20px">{{ t('扫描音频格式') }}：</div>
            <div style="margin-top: 10px; display: flex">
              <span style="margin-right: 10px">.mp3</span>
              <singleCheckbox v-model="audioExt.mp3" @change="extChange()" />
              <span style="margin-right: 10px; margin-left: 10px">.wav</span>
              <singleCheckbox v-model="audioExt.wav" @change="extChange()" />
              <span style="margin-right: 10px; margin-left: 10px">.flac</span>
              <singleCheckbox v-model="audioExt.flac" @change="extChange()" />
            </div>
            <div style="margin-top: 20px">{{ t('聚焦/最小化 FRKB 窗口快捷键') }}：</div>
            <div style="margin-top: 10px">
              <div
                class="chooseDirDiv"
                @click="globalCallShortcutHandle()"
                :title="runtime.setting.globalCallShortcut"
              >
                {{ runtime.setting.globalCallShortcut }}
              </div>
            </div>
            <div style="margin-top: 20px">{{ t('快进时长') }}：</div>
            <div style="margin-top: 10px">
              <input
                class="myInput"
                v-model="runtime.setting.fastForwardTime"
                type="number"
                min="1"
                step="1"
                @input="
                  runtime.setting.fastForwardTime = Math.max(
                    1,
                    Math.floor(Number(runtime.setting.fastForwardTime))
                  )
                "
                @blur="setSetting()"
              />
              {{ t('秒') }}
            </div>
            <div style="margin-top: 20px">{{ t('快退时长') }}：</div>
            <div style="margin-top: 10px">
              <input
                class="myInput"
                v-model="runtime.setting.fastBackwardTime"
                type="number"
                max="-1"
                step="1"
                @input="
                  runtime.setting.fastBackwardTime = Math.min(
                    -1,
                    Math.floor(Number(runtime.setting.fastBackwardTime))
                  )
                "
                @blur="setSetting()"
              />
              {{ t('秒') }}
            </div>
            <div style="margin-top: 20px">
              {{ t('切换歌曲时，自动滚动列表将当前歌曲置于视图中央') }}：
            </div>
            <div style="margin-top: 10px">
              <singleCheckbox
                v-model="runtime.setting.autoScrollToCurrentSong"
                @change="extChange()"
              />
            </div>
            <div style="margin-top: 20px">{{ t('重新选择数据库所在位置') }}：</div>
            <div style="margin-top: 10px">
              <div
                class="button"
                style="width: 90px; text-align: center"
                @click="reSelectLibrary()"
              >
                {{ t('重新选择') }}
              </div>
            </div>
            <div style="margin-top: 20px">{{ t('清除曲目指纹库') }}：</div>
            <div style="margin-top: 10px">
              <div
                class="dangerButton"
                style="width: 90px; text-align: center"
                @click="clearTracksFingerprintLibrary()"
              >
                {{ t('清除') }}
              </div>
            </div>
          </div>
        </OverlayScrollbarsComponent>
        <div style="display: flex; justify-content: center; padding-bottom: 10px; height: 30px">
          <div class="button" @click="cancel()">{{ t('关闭') }} (Esc)</div>
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.myInput {
  width: 50px;
  height: 19px;
  background-color: #313131;
  border: 1px solid #313131;
  outline: none;
  color: #cccccc;
}

.dangerButton {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: #2d2e2e;
  font-size: 14px;

  &:hover {
    color: white;
    background-color: #e81123;
  }
}

select {
  border: 0px solid #313131;
  background-color: #313131;
  color: #cccccc;
  font-size: 14px;
  width: 200px;
  height: 25px;
  padding-left: 5px;
  outline: none;
}

/* 美化选项内容 */
option {
  padding: 5px;
  background-color: #1f1f1f;
  color: #cccccc;
}

.chooseDirDiv {
  height: 25px;
  line-height: 25px;
  background-color: #313131;
  cursor: pointer;
  text-overflow: ellipsis;
  overflow: hidden;
  word-break: break-all;
  white-space: nowrap;
  width: 200px;
  font-size: 14px;
  padding-left: 5px;
}
</style>
