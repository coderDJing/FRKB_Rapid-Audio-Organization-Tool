<script setup>
import { t } from '@renderer/utils/translate.js'
</script>

<template>
  <div style="height: 100%; max-height: 100%; width: 100%; display: flex; flex-direction: column">
    <div
      style="text-align: center; height: 30px; line-height: 30px; font-size: 14px"
      class="canDrag"
    >
      <span style="font-weight: bold" class="title unselectable">{{
        t('首次启动请选择数据存储位置')
      }}</span>
    </div>
    <div style="padding-left: 20px; padding-top: 30px; padding-right: 20px">
      <div style="display: flex">
        <div class="formLabel">
          <span>{{ t('选择文件夹') }}：</span>
        </div>
        <div style="width: 300px">
          <div
            class="chooseDirDiv flashing-border"
            @click="clickChooseDir()"
            :title="folderPathDisplay"
            :class="{ 'is-flashing': flashArea == 'folderPathVal' }"
          >
            {{ folderPathDisplay }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss">
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: #cccccc;
  background-color: #181818;
  width: 100vw;
  height: 100vh;
}

body {
  margin: 0px;
  background-color: #1f1f1f;
}

.chooseDirDiv {
  width: calc(100% - 5px);
  height: 100%;
  background-color: #313131;
  cursor: pointer;
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
</style>
