<script setup>
import { ref } from 'vue'
const barTitle = ref('')
const barNowNum = ref(0)
const barTotal = ref(0)
window.electron.ipcRenderer.on('progressSet', (event, title, nowNum, total) => {
  barTitle.value = title
  barNowNum.value = nowNum
  barTotal.value = total
})
</script>
<template>
  <div style="width: 100%; height: 100%;display: flex;">
    <div style="width: 300px;">//todo</div>
    <div class="container">
      <div class="progress">
        <div class="progress-bar">
        </div>
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
  width: 50%;
}
</style>
