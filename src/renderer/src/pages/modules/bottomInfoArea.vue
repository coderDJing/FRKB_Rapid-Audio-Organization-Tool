<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { i18n } from '@renderer/i18n'
import confirm from '@renderer/components/confirmDialog'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'
const runtime = useRuntimeStore()

const currentLocale = computed(() => i18n.global.locale.value)
const totalDurationLabel = computed(() => t('bottomInfo.totalDurationLabel'))

function formatDurationUnit(unit: 'day' | 'hour' | 'minute' | 'second', count: number): string {
  const pluralKey = count === 1 ? 'one' : 'other'
  return t(`bottomInfo.durationUnits.${unit}.${pluralKey}` as any, { count })
}

type Task = {
  id: string // group id
  titleKey: string // latest phase key
  title: string
  now: number
  total: number
  noNum: boolean
  startedAt: number
  lastUpdateAt: number
  cancelable?: boolean
  cancelChannel?: string
  cancelPayload?: any
  canceling?: boolean
  removing?: boolean
}
const tasks = ref<Task[]>([])
const showTotalRow = ref(tasks.value.length === 0)
// 组件内部通过 CSS 控制显隐（empty => display:none），无需向上层发事件

const playlistTotalDaysHoursSeconds = computed(() => {
  const list = (runtime.songsArea?.songInfoArr || []) as Array<{ duration?: string }>
  let total = 0
  for (const s of list) {
    const mmss = String(s?.duration || '')
    const parts = mmss.split(':')
    if (parts.length === 2) {
      const m = Number(parts[0])
      const sec = Number(parts[1])
      if (!Number.isNaN(m) && !Number.isNaN(sec)) {
        total += m * 60 + sec
      }
    }
  }
  const days = Math.floor(total / 86400)
  const afterDays = total % 86400
  const hours = Math.floor(afterDays / 3600)
  const afterHours = afterDays % 3600
  const minutes = Math.floor(afterHours / 60)
  const seconds = afterHours % 60
  const joiner = currentLocale.value === 'zh-CN' ? '' : ' '
  const segments: string[] = []
  if (days > 0) {
    segments.push(formatDurationUnit('day', days))
  }
  segments.push(formatDurationUnit('hour', hours))
  segments.push(formatDurationUnit('minute', minutes))
  segments.push(formatDurationUnit('second', seconds))
  return segments.join(joiner)
})

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
      }, 500)
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
    const hasCancelMeta =
      'cancelable' in payload || 'cancelChannel' in payload || 'cancelPayload' in payload
    const cancelable = !!payload.cancelable && typeof payload.cancelChannel === 'string'
    const cancelChannel = cancelable ? String(payload.cancelChannel) : undefined
    const cancelPayload = cancelable ? (payload.cancelPayload ?? id) : undefined
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
          lastUpdateAt: Date.now(),
          cancelable,
          cancelChannel,
          cancelPayload,
          canceling: false
        })
      } else {
        const task = tasks.value[idx]
        task.titleKey = titleKey
        task.title = t(titleKey as any)
        task.now = nowNum
        task.total = total
        task.noNum = noNumFlag
        task.lastUpdateAt = Date.now()
        if (hasCancelMeta) {
          task.cancelable = cancelable
          task.cancelChannel = cancelChannel
          task.cancelPayload = cancelPayload
          if (!cancelable) task.canceling = false
        }
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

watch(
  () => tasks.value.length,
  (len) => {
    if (len > 0) {
      showTotalRow.value = false
    }
  }
)

const handleAfterLeave = () => {
  if (tasks.value.length === 0) {
    showTotalRow.value = true
  }
}

const cancelTask = async (task: Task) => {
  if (!task.cancelable || task.canceling) return
  task.canceling = true
  const channel = task.cancelChannel
  if (!channel) {
    task.canceling = false
    return
  }
  try {
    const payload = task.cancelPayload ?? task.id
    await window.electron.ipcRenderer.invoke(channel, payload)
  } catch (error) {
    console.error('cancel task failed', error)
    task.canceling = false
  }
}
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

window.electron.ipcRenderer.on(
  'fingerprints:addExistingFinished',
  async (event, summary, progressId?: string) => {
    runtime.isProgressing = false
    if (progressId) {
      tasks.value = tasks.value.filter((t) => t.id !== String(progressId))
    } else {
      tasks.value = tasks.value.filter((t) => t.id !== 'import')
    }
    const openImportSummary = (await import('@renderer/components/importFinishedSummaryDialog'))
      .default
    if (summary) {
      await openImportSummary(summary)
    }
  }
)
window.electron.ipcRenderer.on('noAudioFileWasScanned', async (_event, progressId?: string) => {
  runtime.isProgressing = false
  runtime.importingSongListUUID = ''
  if (progressId) tasks.value = tasks.value.filter((t) => t.id !== String(progressId))
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
  const scheduleRemoval = (id: string) => {
    if (!id) return
    const task = tasks.value.find((t) => t.id === id)
    if (task && !task.removing) {
      task.removing = true
      setTimeout(() => {
        tasks.value = tasks.value.filter((t) => t.id !== id)
      }, 500)
    } else if (!task) {
      tasks.value = tasks.value.filter((t) => t.id !== id)
    }
  }
  if (doneId) {
    scheduleRemoval(doneId)
  } else {
    scheduleRemoval('audio.convert')
  }
  const openSummary = (await import('@renderer/components/conversionFinishedSummaryDialog')).default
  await openSummary(payload?.summary || null)
})
</script>
<template>
  <div class="bottom-info-area" :class="{ empty: tasks.length === 0 }">
    <TransitionGroup name="progress-fade" tag="div" @after-leave="handleAfterLeave">
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
        <div class="actions" v-if="task.cancelable">
          <button class="cancel-btn" :disabled="task.canceling" @click="cancelTask(task)">
            {{ t('common.cancel') }}
          </button>
        </div>
      </div>
    </TransitionGroup>
    <div
      v-if="
        showTotalRow && runtime.songsArea.songListUUID && runtime.songsArea.songInfoArr.length > 0
      "
      class="total-row"
    >
      <div class="total-text">{{ totalDurationLabel }}{{ playlistTotalDaysHoursSeconds }}</div>
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
.actions {
  display: flex;
  align-items: center;
  padding: 0 8px 0 4px;
}
.cancel-btn {
  border: 1px solid var(--divider);
  background: transparent;
  color: var(--text);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.cancel-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--text-weak);
}
.cancel-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
  transition: width 0.2s ease;
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
  box-sizing: border-box;
  overflow: hidden;
  max-height: 400px;
  min-height: 24px;
  opacity: 1;
  transition:
    max-height 0.3s ease,
    padding 0.3s ease,
    opacity 0.2s ease;
}
.bottom-info-area.empty {
  max-height: 24px;
  opacity: 1;
  padding: 2px 0;
  pointer-events: none;
}
.task-row {
  width: 100%;
  display: flex;
  align-items: center;
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
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
.total-row {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  min-height: 20px;
  padding: 0 8px;
}
.total-text {
  font-size: 11px;
  color: var(--text-weak);
  white-space: nowrap;
  margin-bottom: 2px;
}

.progress-fade-enter-from,
.progress-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.progress-fade-leave-active {
  position: relative;
}

.progress-fade-enter-active,
.progress-fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
</style>
