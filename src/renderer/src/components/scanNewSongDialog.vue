<script setup>
import { ref } from 'vue'
import singleCheckbox from './singleCheckbox.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import selectSongListDialog from './selectSongListDialog.vue'
import libraryUtils from '@renderer/utils/libraryUtils.js'
import hintIcon from '@renderer/assets/hint.png'
const runtime = useRuntimeStore()
const folderPathVal = ref('') //文件夹路径
const clickChooseDir = async () => {
  const folderPath = await window.electron.ipcRenderer.invoke('select-folder')
  if (folderPath) {
    folderPathVal.value = folderPath
  }
}

//todo测试音频播放可行性代码待删除-------------
// const audioContext = new AudioContext();
// async function play() {
//   const audioData = await window.electron.ipcRenderer.invoke('aaa')
//   const uint8Buffer = Uint8Array.from(audioData)
//   // const bolb = new Blob([uint8Buffer])
//   // let bolbUrl = window.URL.createObjectURL(bolb)
//   // setTimeout(() => {
//   //   let audioPlayer = document.getElementById('audioPlayer');
//   //   audioPlayer.src = bolbUrl;
//   //   audioPlayer.addEventListener('ended', function () {
//   //     window.URL.revokeObjectURL(bolbUrl);
//   //   });
//   // }, 1000)

//   // audioContext.decodeAudioData(uint8Buffer.buffer, (buffer) => {
//   //   const source = audioContext.createBufferSource();
//   //   source.buffer = buffer;
//   //   source.connect(audioContext.destination);
//   //   source.start(0); // 开始播放
//   // })
// }
// play()
// async function play() {
//   const audioData = await window.electron.ipcRenderer.invoke('aaa')
//   const uint8Buffer = Uint8Array.from(audioData)

//   audioContext.decodeAudioData(uint8Buffer.buffer, (buffer) => {
//     const source = audioContext.createBufferSource();
//     source.buffer = buffer;
//     source.connect(audioContext.destination);
//     source.start(0); // 开始播放
//   })
// }
// play()
//---------------------

const runtimeLayoutConfigChanged = () => {
  window.electron.ipcRenderer.send('layoutConfigChanged', JSON.stringify(runtime.layoutConfig))
}

const isDeleteSourceFileChange = (bool) => {
  if (bool == false && runtime.layoutConfig.scanNewSongDialog.isDeleteSourceDir == true) {
    runtime.layoutConfig.scanNewSongDialog.isDeleteSourceDir = false
  }
  runtimeLayoutConfigChanged()
}

const isDeleteSourceDirChange = (bool) => {
  if (bool) {
    runtime.layoutConfig.scanNewSongDialog.isDeleteSourceFile = true
  }
  runtimeLayoutConfigChanged()
}

const emits = defineEmits(['cancel'])

const flashArea = ref('') // 控制动画是否正在播放

// 模拟闪烁三次的逻辑（使用 setTimeout）
const flashBorder = (flashAreaName) => {
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
const clickChooseSongList = () => {
  runtime.selectSongListDialogShow = true
}
let songListSelectedPath = ''
const selectSongListDialogConfirm = (uuid) => {
  songListSelectedPath = libraryUtils.findDirPathByUuid(runtime.libraryTree, uuid)
  let songListSelectedPathArr = libraryUtils.findDirPathByUuid(runtime.libraryTree, uuid).split('/')
  songListSelectedPathArr.shift()
  songListSelectedPathArr.shift()
  songListSelected.value = songListSelectedPathArr.join('\\')
  runtime.selectSongListDialogShow = false
}

const confirm = () => {
  if (!folderPathVal.value) {
    if (!flashArea.value) {
      flashBorder('folderPathVal')
    }
    return
  }
  if (!songListSelected.value) {
    if (!flashArea.value) {
      flashBorder('songListPathVal')
    }
    return
  }
  window.electron.ipcRenderer.send('startImportSongs', {
    folderPath: folderPathVal.value,
    songListPath: songListSelectedPath,
    isDeleteSourceFile: runtime.layoutConfig.scanNewSongDialog.isDeleteSourceFile,
    isDeleteSourceDir: runtime.layoutConfig.scanNewSongDialog.isDeleteSourceDir,
    isComparisonSongFingerprint: runtime.layoutConfig.scanNewSongDialog.isComparisonSongFingerprint,
    isPushSongFingerprintLibrary:
      runtime.layoutConfig.scanNewSongDialog.isPushSongFingerprintLibrary
  })
  cancel()
}
const cancel = () => {
  emits('cancel')
}
let hint1hoverTimer = null
let hint1Show = ref(false)
const hint1IconMouseover = () => {
  hint1hoverTimer = setTimeout(() => {
    hint1Show.value = true
  }, 500)
}
const hint1IconMouseout = () => {
  clearTimeout(hint1hoverTimer)
  hint1Show.value = false
}
let hint2hoverTimer = null
let hint2Show = ref(false)
const hint2IconMouseover = () => {
  hint2hoverTimer = setTimeout(() => {
    hint2Show.value = true
  }, 500)
}
const hint2IconMouseout = () => {
  clearTimeout(hint2hoverTimer)
  hint2Show.value = false
}
</script>
<template>
  <div class="dialog unselectable">
    <!-- <audio id="audioPlayer" controls autoplay>
                      todo测试音频播放可行性代码待删除-------------
                          </audio> -->
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
          <span style="font-weight: bold">导入新歌曲</span>
        </div>
        <div style="padding-left: 20px; padding-top: 30px; padding-right: 20px">
          <div style="display: flex">
            <div class="formLabel"><span>选择文件夹：</span></div>
            <div style="width: 310px">
              <div
                class="chooseDirDiv flashing-border"
                @click="clickChooseDir()"
                :title="folderPathVal"
                :class="{ 'is-flashing': flashArea == 'folderPathVal' }"
              >
                {{ folderPathVal }}
              </div>
            </div>
          </div>
          <div style="margin-top: 10px; display: flex">
            <div class="formLabel"><span>选择歌单：</span></div>

            <div style="width: 310px">
              <div
                class="chooseDirDiv flashing-border"
                @click="clickChooseSongList()"
                :title="songListSelected"
                :class="{ 'is-flashing': flashArea == 'songListPathVal' }"
              >
                {{ songListSelected }}
              </div>
            </div>
          </div>
          <div style="margin-top: 30px; display: flex">
            <div class="formLabel" style="width: 130px; text-align: right">
              <span>导入后删除原文件：</span>
            </div>
            <div style="width: 21px; height: 21px; display: flex; align-items: center">
              <singleCheckbox
                v-model="runtime.layoutConfig.scanNewSongDialog.isDeleteSourceFile"
                @change="isDeleteSourceFileChange"
              />
            </div>
          </div>
          <div style="margin-top: 10px; display: flex">
            <div class="formLabel" style="width: 130px; text-align: right">
              <span>比对声音指纹去重：</span>
            </div>
            <div style="width: 21px; height: 21px; display: flex; align-items: center">
              <singleCheckbox
                v-model="runtime.layoutConfig.scanNewSongDialog.isComparisonSongFingerprint"
                @change="runtimeLayoutConfigChanged()"
              />
            </div>
            <div style="height: 21px; display: flex; align-items: center; padding-left: 3px">
              <img
                :src="hintIcon"
                style="width: 15px; height: 15px"
                @mouseover="hint1IconMouseover()"
                @mouseout="hint1IconMouseout()"
              />
              <transition name="fade">
                <div
                  class="bubbleBox"
                  v-if="hint1Show"
                  style="
                    position: absolute;
                    height: 66px;
                    width: 200px;
                    margin-left: 20px;
                    margin-top: 50px;
                    text-align: left;
                  "
                >
                  将对所有导入过并加入声音指纹库的歌曲进行比对，重复的歌曲将不会被导入，哪怕它曾经已被删除
                </div>
              </transition>
            </div>
          </div>
          <div style="margin-top: 10px; display: flex">
            <div class="formLabel" style="width: 130px; text-align: right">
              <span>加入声音指纹库：</span>
            </div>
            <div style="width: 21px; height: 21px; display: flex; align-items: center">
              <singleCheckbox
                v-model="runtime.layoutConfig.scanNewSongDialog.isPushSongFingerprintLibrary"
                @change="runtimeLayoutConfigChanged()"
              />
            </div>
            <div style="height: 21px; display: flex; align-items: center; padding-left: 3px">
              <img
                :src="hintIcon"
                style="width: 15px; height: 15px"
                @mouseover="hint2IconMouseover()"
                @mouseout="hint2IconMouseout()"
              />
              <transition name="fade">
                <div
                  class="bubbleBox"
                  v-if="hint2Show"
                  style="
                    position: absolute;
                    height: 88px;
                    width: 200px;
                    margin-left: 20px;
                    margin-top: 50px;
                    text-align: left;
                  "
                >
                  将导入的歌曲根据歌曲内容本身进行声音指纹分析，并将分析结果永久入库供以后去重比对，哪怕歌曲本身已经被删除分析结果仍会存在
                </div>
              </transition>
            </div>
          </div>
          <!-- <div style="margin-top: 10px; display: flex">
                        <div class="formLabel" style="width: 130px"><span>导入后删除文件夹：</span></div>
                        <div style="width: 21px; height: 21px; display: flex; align-items: center">
                          <singleCheckbox v-model="runtime.layoutConfig.scanNewSongDialog.isDeleteSourceDir"
                            @change="isDeleteSourceDirChange" />
                        </div>
                      </div> -->
        </div>
      </div>

      <div style="display: flex; justify-content: center; padding-bottom: 10px">
        <div class="button" style="margin-right: 10px" @click="confirm()">确定</div>
        <div class="button" @click="cancel()">取消</div>
      </div>
    </div>
  </div>
  <selectSongListDialog
    v-if="runtime.selectSongListDialogShow"
    @confirm="selectSongListDialogConfirm"
    @cancel="
      () => {
        runtime.selectSongListDialogShow = false
      }
    "
  />
</template>
<style lang="scss" scoped>
.chooseDirDiv {
  width: 100%;
  height: 100%;
  line-height: 21px;
  background-color: #313131;
  cursor: pointer;
  text-overflow: ellipsis;
  overflow: hidden;
  word-break: break-all;
  white-space: nowrap;
  max-width: 100%;
  font-size: 14px;
  padding-left: 5px;
}

.formLabel {
  width: 100px;
  min-width: 100px;
  text-align: left;
  font-size: 14px;
}
</style>
