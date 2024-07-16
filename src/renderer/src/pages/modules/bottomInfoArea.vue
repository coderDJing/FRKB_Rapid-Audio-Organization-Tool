<script setup>
import { ref } from 'vue'
import confirm from '@renderer/components/confirm.js'

const barTitle = ref('')
const barNowNum = ref(0)
const barTotal = ref(0)
window.electron.ipcRenderer.on('progressSet', (event, title, nowNum, total) => {
  barTitle.value = title
  barNowNum.value = nowNum
  barTotal.value = total
  if (nowNum == total) {
    barTitle.value = ''
  }
})
window.electron.ipcRenderer.on('importFinished', async (event, contentArr) => {
  await confirm({
    title: '导入完成',
    content: contentArr,
    textAlign: 'left',
    innerHeight: 250,
    confirmShow: false
  })
})
</script>
<template>
  <div style="width: 100%; height: 100%; display: flex">
    <div
      v-if="barTitle"
      style="width: fit-content; font-size: 10px; height: 19px; line-height: 19px; padding: 0 10px"
    >
      {{ barTitle + '...' }}
      {{ barNowNum }} /
      {{ barTotal }}
    </div>
    <div class="container" v-if="barTitle">
      <div class="progress">
        <div class="progress-bar" :style="'width:' + (barNowNum / barTotal) * 100 + '%'"></div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
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
