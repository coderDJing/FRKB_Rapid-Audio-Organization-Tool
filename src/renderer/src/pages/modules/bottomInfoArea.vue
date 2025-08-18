<script setup lang="ts">
import { ref } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
const runtime = useRuntimeStore()
const barTitle = ref('')
const barNowNum = ref(0)
const barTotal = ref(0)
const noNum = ref(false)
window.electron.ipcRenderer.on('progressSet', (event, title, nowNum, total, noNumFlag) => {
  barTitle.value = t(title as any)
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
window.electron.ipcRenderer.on('importFinished', async (event, _songListUUID, importSummary) => {
  runtime.isProgressing = false
  runtime.importingSongListUUID = ''
  const openImportSummary = (await import('@renderer/components/importFinishedSummaryDialog'))
    .default
  await openImportSummary(importSummary)
})

window.electron.ipcRenderer.on('addSongFingerprintFinished', async (event, fingerprintSummary) => {
  runtime.isProgressing = false
  const openFingerprintSummary = (
    await import('@renderer/components/addSongFingerprintFinishedDialog')
  ).default
  await openFingerprintSummary(fingerprintSummary)
})
window.electron.ipcRenderer.on('noAudioFileWasScanned', async (event) => {
  runtime.isProgressing = false
  runtime.importingSongListUUID = ''
  await confirm({
    title: t('common.finished'),
    content: [t('fingerprints.noAudioFilesFound')],
    textAlign: 'center',
    innerHeight: 250,
    innerWidth: 400,
    confirmShow: false
  })
})
</script>
<template>
  <div style="width: 100%; height: 100%; display: flex; align-items: center" v-if="barTitle">
    <div
      style="
        display: flex;
        justify-content: center;
        align-items: center;
        padding-left: 5px;
        height: 20px;
      "
    >
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
      style="width: fit-content; font-size: 10px; height: 20px; line-height: 20px; padding: 0 5px"
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
  height: 20px;
  display: flex;
  align-items: center;
  position: relative;
}

.progress-bar {
  position: absolute;
  top: 7px;
  left: 0;
  height: 5px;
  background: linear-gradient(90deg, #3a7afe, #4da3ff);
  background-size: 200% 100%;
  animation: slideBg 3s linear infinite;
  border-radius: 3px;
  overflow: hidden;
  will-change: background-position, width;
}

.progress-bar::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image: repeating-linear-gradient(
    45deg,
    rgba(255, 255, 255, 0.12) 0 8px,
    rgba(255, 255, 255, 0.04) 8px 16px
  );
  mix-blend-mode: overlay;
  animation: moveStripes 2s linear infinite;
  will-change: background-position;
}

.progress-bar::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0.25) 50%,
    rgba(255, 255, 255, 0) 100%
  );
  transform: translateX(-100%);
  animation: shine 3.6s ease-in-out infinite;
  will-change: transform;
}

@keyframes slideBg {
  0% {
    background-position: 0 0;
  }
  100% {
    background-position: -200% 0;
  }
}

@keyframes moveStripes {
  0% {
    background-position: 0 0;
  }
  100% {
    background-position: 100px 0;
  }
}

@keyframes shine {
  0% {
    transform: translateX(-100%);
  }
  50% {
    transform: translateX(0);
  }
  100% {
    transform: translateX(100%);
  }
}
</style>
