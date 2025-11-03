<script setup lang="ts">
import { ref, watch } from 'vue'
import confirm from '@renderer/components/confirmDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
const runtime = useRuntimeStore()

type Task = {
  id: string // group id
  titleKey: string // latest phase key
  title: string
  now: number
  total: number
  noNum: boolean
  startedAt: number
  lastUpdateAt: number
  removing?: boolean
}
const tasks = ref<Task[]>([])
// 组件内部通过 CSS 控制显隐（empty => display:none），无需向上层发事件

function getGroupId(titleKey: string): string {
  if (typeof titleKey !== 'string') return String(titleKey)
  if (titleKey.startsWith('fingerprints.')) return 'import'
  if (titleKey.startsWith('tracks.')) return 'import'
  return String(titleKey)
}

function upsertTask(titleKey: string, nowNum: number, total: number, noNumFlag?: boolean) {
  const id = getGroupId(titleKey)
  const idx = tasks.value.findIndex((t) => t.id === id)
  if (idx === -1) {
    tasks.value.push({
      id,
      titleKey,
      title: t(titleKey as any),
      now: nowNum,
      total,
      noNum: !!noNumFlag,
      startedAt: Date.now(),
      lastUpdateAt: Date.now()
    })
  } else {
    const task = tasks.value[idx]
    task.titleKey = titleKey
    task.title = t(titleKey as any)
    task.now = nowNum
    task.total = total
    task.noNum = !!noNumFlag
    task.lastUpdateAt = Date.now()
  }
  // 完成后延迟移除
  if (nowNum >= total && total > 0) {
    const task = tasks.value.find((t) => t.id === id)
    if (task && !task.removing) {
      task.removing = true
      setTimeout(() => {
        tasks.value = tasks.value.filter((t) => t.id !== id)
      }, 1500)
    }
  }
}

window.electron.ipcRenderer.on('progressSet', (_event, arg1, arg2, arg3, arg4) => {
  if (arg1 && typeof arg1 === 'object') {
    const payload = arg1 as any
    const id = String(payload.id || '')
    const titleKey = String(payload.titleKey || '')
    const nowNum = Number(payload.now || 0)
    const total = Number(payload.total || 0)
    const noNumFlag = !!payload.isInitial
    if (id && titleKey) {
      // 直接以 id 作为分组键；覆盖阶段
      const idx = tasks.value.findIndex((t) => t.id === id)
      if (idx === -1) {
        tasks.value.push({
          id,
          titleKey,
          title: t(titleKey as any),
          now: nowNum,
          total,
          noNum: noNumFlag,
          startedAt: Date.now(),
          lastUpdateAt: Date.now()
        })
      } else {
        const task = tasks.value[idx]
        task.titleKey = titleKey
        task.title = t(titleKey as any)
        task.now = nowNum
        task.total = total
        task.noNum = noNumFlag
        task.lastUpdateAt = Date.now()
      }
      // 仅对非 import/fingerprint/convert 类任务启用“自动移除”（这些任务有独立完成事件来清理）
      const canAutoRemove = !/^import_|^fingerprints_|^convert_/i.test(id)
      if (canAutoRemove && nowNum >= total && total > 0) {
        const task = tasks.value.find((t) => t.id === id)
        if (task && !task.removing) {
          task.removing = true
          setTimeout(() => {
            tasks.value = tasks.value.filter((t) => t.id !== id)
          }, 1500)
        }
      }
      return
    }
  }
  // 兼容旧签名
  const titleKey = arg1
  const nowNum = arg2
  const total = arg3
  const noNumFlag = arg4
  upsertTask(String(titleKey), Number(nowNum) || 0, Number(total) || 0, !!noNumFlag)
})
window.electron.ipcRenderer.on(
  'importFinished',
  async (event, _songListUUID, importSummary, progressId?: string) => {
    runtime.isProgressing = false
    runtime.importingSongListUUID = ''
    // 有 progressId 则按 id 清理；否则清理整组 import
    if (progressId) {
      tasks.value = tasks.value.filter((t) => t.id !== String(progressId))
    } else {
      tasks.value = tasks.value.filter((t) => t.id !== 'import')
    }
    const openImportSummary = (await import('@renderer/components/importFinishedSummaryDialog'))
      .default
    await openImportSummary(importSummary)
  }
)

window.electron.ipcRenderer.on(
  'addSongFingerprintFinished',
  async (event, fingerprintSummary, progressId?: string) => {
    runtime.isProgressing = false
    // 清理导入/指纹相关进度行
    if (progressId) {
      tasks.value = tasks.value.filter((t) => t.id !== String(progressId))
    } else {
      tasks.value = tasks.value.filter((t) => t.id !== 'import')
    }
    const openFingerprintSummary = (
      await import('@renderer/components/addSongFingerprintFinishedDialog')
    ).default
    await openFingerprintSummary(fingerprintSummary)
  }
)
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

// 音频转换完成摘要弹窗（简要）
window.electron.ipcRenderer.on('audio:convert:done', async (_e, payload) => {
  // 清理转换进度行
  const doneId = String(payload?.jobId || '')
  if (doneId) {
    tasks.value = tasks.value.filter((t) => t.id !== doneId)
  } else {
    tasks.value = tasks.value.filter((t) => t.id !== 'audio.convert')
  }
  const openSummary = (await import('@renderer/components/conversionFinishedSummaryDialog')).default
  await openSummary(payload?.summary || null)
})
</script>
<template>
  <div class="bottom-info-area" :class="{ empty: tasks.length === 0 }">
    <div v-for="task in tasks" :key="task.id" class="task-row">
      <div class="spinner">
        <div class="loading">
          <div></div>
          <div></div>
          <div></div>
          <div></div>
          <div></div>
        </div>
      </div>
      <div class="label">
        {{ task.title }}
        <span v-show="!task.noNum">{{ task.now }} / {{ task.total }}</span>
      </div>
      <div class="container">
        <div class="progress">
          <div
            class="progress-bar"
            :style="'width:' + (task.total ? (task.now / task.total) * 100 : 0) + '%'"
          />
        </div>
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
  color: var(--text);
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

.bottom-info-area {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px 0;
}
.bottom-info-area.empty {
  padding: 0;
  display: none;
}
.task-row {
  width: 100%;
  display: flex;
  align-items: center;
}
.spinner {
  display: flex;
  align-items: center;
  padding-left: 5px;
  height: 20px;
}
.label {
  width: fit-content;
  font-size: 10px;
  height: 20px;
  line-height: 20px;
  padding: 0 5px;
}
</style>
