<script setup>
import { ref } from 'vue'
import singleCheckbox from './singleCheckbox.vue';
import { useRuntimeStore } from '@renderer/stores/runtime'

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
  }
}
const cancel = () => {
  emits('cancel')
}
</script>
<template>
  <div class="dialog unselectable">
    <div style="width: 450px;height: 260px;display: flex;flex-direction: column;justify-content: space-between;"
      class="inner">
      <div>
        <div style="text-align: center;height:30px;line-height: 30px;font-size: 14px;"><span>导入新歌曲</span></div>
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
            <div style="width:310px">
              //todo
            </div>
          </div>
          <div style="margin-top: 10px;display: flex;">
            <div class="formLabel"><span>删除原文件：</span></div>
            <div style="width:21px;height: 21px;display: flex;align-items: center;">
              <singleCheckbox v-model="runtime.layoutConfig.scanNewSongDialog.isDeleteSourceFile"
                @change="isDeleteSourceFileChange" />
            </div>
          </div>
          <div style="margin-top: 10px;display: flex;">
            <div class="formLabel"><span>删除文件夹：</span></div>
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
}

.formLabel {
  width: 100px;
  min-width: 100px;
  text-align: right;
}

.flashing-border {
  border: 1px solid transparent;
  /* 初始边框为透明，以便动画从透明到#0078d4 */
  transition: border-color 0.2s ease;
  /* 过渡效果使边框颜色变化更平滑 */
}

.flashing-border.is-flashing {
  animation: flash 0.5s infinite;
  /* 1.5秒内闪烁三次，但infinite会被下面的JavaScript逻辑覆盖 */
}

@keyframes flash {

  0%,
  100% {
    border-color: transparent;
  }

  /* 开始和结束都是透明 */
  33.33%,
  66.66% {
    border-color: #0078d4;
  }

  /* 在1/3和2/3的时间点显示边框 */
}
</style>
