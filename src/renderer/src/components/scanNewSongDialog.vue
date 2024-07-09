<script setup>
import { ref } from 'vue'
import singleCheckbox from './singleCheckbox.vue';
import { useRuntimeStore } from '@renderer/stores/runtime'
import selectSongListDialog from './selectSongListDialog.vue';
import libraryUtils from '@renderer/utils/libraryUtils.js'
const runtime = useRuntimeStore()
const folderPathVal = ref('') //文件夹路径
const clickChooseDir = async () => {
  const folderPath = await window.electron.ipcRenderer.invoke('select-folder')
  if (folderPath) {
    folderPathVal.value = folderPath
  }
}

const runtimeLayoutConfigChanged = () => {
  window.electron.ipcRenderer.send('layoutConfigChanged', JSON.stringify(runtime.layoutConfig));
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




const flashArea = ref(''); // 控制动画是否正在播放


// 模拟闪烁三次的逻辑（使用 setTimeout）
const flashBorder = (flashAreaName) => {
  flashArea.value = flashAreaName
  let count = 0;
  const interval = setInterval(() => {
    count++;
    if (count >= 3) {
      clearInterval(interval);
      flashArea.value = ''; // 动画结束，不再闪烁
    }
  }, 500); // 每次闪烁间隔 500 毫秒
};
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
  //todo真正开始导入歌曲
}
const cancel = () => {
  emits('cancel')
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
</script>
<template>
  <div class="dialog unselectable">
    <div style="width: 450px;height: 260px;display: flex;flex-direction: column;justify-content: space-between;"
      class="inner">
      <div>
        <div style="text-align: center;height:30px;line-height: 30px;font-size: 14px;"><span
            style="font-weight: bold;">导入新歌曲</span></div>
        <div style="padding-left: 20px;padding-top: 30px;padding-right: 20px;">
          <div style="display: flex;">
            <div class="formLabel"><span>选择文件夹：</span></div>
            <div style="width: 310px;">
              <div class="chooseDirDiv flashing-border" @click="clickChooseDir()" :title="folderPathVal"
                :class="{ 'is-flashing': flashArea == 'folderPathVal' }">
                {{ folderPathVal }}
              </div>
            </div>
          </div>
          <div style="margin-top: 10px;display: flex;">
            <div class="formLabel"><span>选择歌单：</span></div>

            <div style="width: 310px;">
              <div class="chooseDirDiv flashing-border" @click="clickChooseSongList()" :title="songListSelected"
                :class="{ 'is-flashing': flashArea == 'songListPathVal' }">
                {{ songListSelected }}
              </div>

            </div>
          </div>
          <div style="margin-top: 30px;display: flex;">
            <div class="formLabel" style="width:130px"><span>导入后删除原文件：</span></div>
            <div style="width:21px;height: 21px;display: flex;align-items: center;">
              <singleCheckbox v-model="runtime.layoutConfig.scanNewSongDialog.isDeleteSourceFile"
                @change="isDeleteSourceFileChange" />
            </div>
          </div>
          <div style="margin-top: 10px;display: flex;">
            <div class="formLabel" style="width:130px"><span>导入后删除文件夹：</span></div>
            <div style="width:21px;height: 21px;display: flex;align-items: center;">
              <singleCheckbox v-model="runtime.layoutConfig.scanNewSongDialog.isDeleteSourceDir"
                @change="isDeleteSourceDirChange" />
            </div>
          </div>
        </div>
      </div>

      <div style="display: flex;justify-content: center;padding-bottom: 10px;">
        <div class="button" style="margin-right: 10px;" @click="confirm()">
          确定
        </div>
        <div class="button" @click="cancel()">
          取消
        </div>
      </div>
    </div>
  </div>
  <selectSongListDialog v-if="runtime.selectSongListDialogShow" @confirm="selectSongListDialogConfirm"
    @cancel="() => { runtime.selectSongListDialogShow = false }" />
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
