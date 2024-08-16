<script setup>
import { ref } from 'vue'
import confirm from '@renderer/components/confirmDialog.js'
import { useRuntimeStore } from '@renderer/stores/runtime'

const runtime = useRuntimeStore()
const barTitle = ref('')
const barNowNum = ref(0)
const barTotal = ref(0)
const noNum = ref(false)
window.electron.ipcRenderer.on('progressSet', (event, title, nowNum, total, noNumFlag) => {
  barTitle.value = title
  if (noNumFlag) {
    noNum.value = true
  } else {
    noNum.value = false
  }
  barNowNum.value = nowNum
  barTotal.value = total
  if (nowNum == total) {
    barTitle.value = ''
    noNum.value = false
  }
})
window.electron.ipcRenderer.on('importFinished', async (event, contentArr) => {
  runtime.isProgressing = false
  runtime.importingSongListUUID = ''
  await confirm({
    title: '导入完成',
    content: contentArr,
    textAlign: 'left',
    innerHeight: 280,
    innerWidth: 400,
    confirmShow: false
  })
})

window.electron.ipcRenderer.on('addSongFingerprintFinished', async (event, contentArr) => {
  runtime.isProgressing = false
  await confirm({
    title: '添加完成',
    content: contentArr,
    textAlign: 'left',
    innerHeight: 250,
    innerWidth: 400,
    confirmShow: false
  })
})
</script>
<template>
  <div style="width: 100%; height: 100%; display: flex" v-if="barTitle">
    <div style="display: flex; justify-content: center; align-items: center; padding-left: 5px">
      <div class="loading">
        <div></div>
        <div></div>
        <div></div>
        <div></div>
        <div></div>
      </div>
    </div>
    <div
      v-if="barTitle"
      style="width: fit-content; font-size: 10px; height: 19px; line-height: 19px; padding: 0 5px"
    >
      {{ barTitle }}
      <span v-show="!noNum">{{ barNowNum }} / {{ barTotal }}</span>
    </div>
    <div class="container" v-if="barTitle">
      <div class="progress">
        <div class="progress-bar" :style="'width:' + (barNowNum / barTotal) * 100 + '%'"></div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.loading,
.loading > div {
  position: relative;
  box-sizing: border-box;
}

.loading {
  display: block;
  font-size: 0;
  color: #cccccc;
}

.loading.la-dark {
  color: #333;
}

.loading > div {
  display: inline-block;
  float: none;
  background-color: currentColor;
  border: 0 solid currentColor;
}

.loading {
  width: 40px;
  height: 15px;
}

.loading > div {
  width: 4px;
  height: 15px;
  margin: 2px;
  margin-top: 0;
  margin-bottom: 0;
  border-radius: 0;
  animation: line-scale 1.2s infinite ease;
}

.loading > div:nth-child(1) {
  animation-delay: -1.2s;
}

.loading > div:nth-child(2) {
  animation-delay: -1.1s;
}

.loading > div:nth-child(3) {
  animation-delay: -1s;
}

.loading > div:nth-child(4) {
  animation-delay: -0.9s;
}

.loading > div:nth-child(5) {
  animation-delay: -0.8s;
}

.loading.la-sm {
  width: 20px;
  height: 16px;
}

.loading.la-sm > div {
  width: 2px;
  height: 16px;
  margin: 1px;
  margin-top: 0;
  margin-bottom: 0;
}

.loading.la-2x {
  width: 80px;
  height: 64px;
}

.loading.la-2x > div {
  width: 8px;
  height: 64px;
  margin: 4px;
  margin-top: 0;
  margin-bottom: 0;
}

.loading.la-3x {
  width: 120px;
  height: 96px;
}

.loading.la-3x > div {
  width: 12px;
  height: 96px;
  margin: 6px;
  margin-top: 0;
  margin-bottom: 0;
}

@keyframes line-scale {
  0%,
  40%,
  100% {
    transform: scaleY(0.4);
  }

  20% {
    transform: scaleY(1);
  }
}

.container {
  height: 100%;
  flex-grow: 1;
  text-align: center;
}

.progress {
  height: 100%;
  display: flex;
  align-items: center;
}

.progress-bar {
  height: 5px;
  background-color: #0078d4;
  // border-radius: 4px;
  // width: 100%;
}
</style>
