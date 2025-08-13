<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '@renderer/utils/utils'
import { t } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'
const emits = defineEmits(['cancel'])
const uuid = uuidV4()

const configured = ref<boolean | null>(null)
const syncing = ref(false)
const phase = ref<
  'checking' | 'diffing' | 'analyzing' | 'pulling' | 'committing' | 'finalizing' | 'idle'
>('idle')
const percent = ref(0)
const logMsg = ref('')
const summary = ref<any | null>(null)
const progressDetails = ref<any>({})

const stages = [
  { key: 'checking', label: '检查中' },
  { key: 'diffing', label: '比对中' },
  { key: 'analyzing', label: '分析中' },
  { key: 'pulling', label: '拉取中' },
  { key: 'committing', label: '提交中' },
  { key: 'finalizing', label: '收尾' }
]
const phaseIndexMap: Record<string, number> = stages.reduce(
  (acc, s, i) => {
    acc[s.key] = i
    return acc
  },
  {} as Record<string, number>
)
const currentPhaseIndex = computed(() => phaseIndexMap[phase.value] ?? -1)

const startSync = async () => {
  const res = await window.electron.ipcRenderer.invoke('cloudSync/start')
  if (res === 'not_configured') {
    logMsg.value = t('尚未配置云同步，将打开设置面板')
    window.setTimeout(() => {
      emits('cancel')
      window.setTimeout(() => {
        const evt = new CustomEvent('openDialogFromChild', { detail: '云同步设置' })
        window.dispatchEvent(evt)
      }, 50)
    }, 300)
    return
  }
  syncing.value = true
}

const isErrorPromptOpen = ref(false)

// 事件处理函数需要具名，便于移除监听，避免重复绑定导致多重弹窗
const handleState = (_e: any, state: string) => {
  if (state === 'syncing') {
    syncing.value = true
    return
  }
  if (state === 'success' || state === 'failed' || state === 'cancelled') {
    syncing.value = false
    if (state !== 'success') {
      percent.value = 0
      phase.value = 'idle'
    }
  }
}
const isNoticePromptOpen = ref(false)
const handleNotice = (_e: any, payload: any) => {
  if (isNoticePromptOpen.value) return
  const msg = payload?.message || ''
  if (!msg) return
  isNoticePromptOpen.value = true
  // 先关闭同步面板
  emits('cancel')
  // 同时弹出提示对话框（非阻塞）
  void confirm({ title: '提示', content: [t(msg)], confirmShow: false })
}
const handleProgress = (_e: any, p: any) => {
  phase.value = p.phase
  percent.value = p.percent
  progressDetails.value = p.details || {}
}
const handleError = async (_e: any, err: any) => {
  // 网络错误或其他错误：仅提示并复位，用户手动点击“开始同步”自行重试
  syncing.value = false
  percent.value = 0
  phase.value = 'idle'
  if (isErrorPromptOpen.value) return
  isErrorPromptOpen.value = true
  try {
    logMsg.value = t(err?.message || 'error')
    await confirm({ title: '错误', content: [logMsg.value], confirmShow: false })
  } finally {
    isErrorPromptOpen.value = false
  }
}

const closeSummaryAndCancel = () => {
  summary.value = null
  emits('cancel')
}

const formatDurationSec = (ms: number) => {
  const seconds = ms / 1000
  if (seconds >= 10) return String(Math.round(seconds))
  return String(Math.round(seconds * 10) / 10)
}

onMounted(async () => {
  const cfg = await window.electron.ipcRenderer.invoke('cloudSync/config/get')
  configured.value = !!cfg?.userKey
  hotkeys('Esc', uuid, () => emits('cancel'))
  utils.setHotkeysScpoe(uuid)
  // 防止累积：先清理仅由本组件使用的事件
  window.electron.ipcRenderer.removeAllListeners('cloudSync/state')
  window.electron.ipcRenderer.removeAllListeners('cloudSync/notice')
  window.electron.ipcRenderer.removeAllListeners('cloudSync/progress')
  window.electron.ipcRenderer.removeAllListeners('cloudSync/error')
  window.electron.ipcRenderer.removeAllListeners('cloudSync/summary')
  window.electron.ipcRenderer.on('cloudSync/state', handleState)
  window.electron.ipcRenderer.on('cloudSync/notice', handleNotice)
  window.electron.ipcRenderer.on('cloudSync/progress', handleProgress)
  window.electron.ipcRenderer.on('cloudSync/error', handleError)
  window.electron.ipcRenderer.on('cloudSync/summary', (_e, s) => {
    syncing.value = false
    summary.value = s
  })
})
onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  window.electron.ipcRenderer.removeAllListeners('cloudSync/state')
  window.electron.ipcRenderer.removeAllListeners('cloudSync/notice')
  window.electron.ipcRenderer.removeAllListeners('cloudSync/progress')
  window.electron.ipcRenderer.removeAllListeners('cloudSync/error')
  window.electron.ipcRenderer.removeAllListeners('cloudSync/summary')
})
</script>

<template>
  <div class="dialog unselectable">
    <div class="inner">
      <div class="title">{{ t('同步曲目指纹库') }}</div>
      <div v-if="configured === false" class="hint">{{ t('尚未配置云同步') }}</div>
      <div class="stages">
        <div
          class="stage"
          v-for="(s, i) in stages"
          :key="s.key"
          :class="{ active: i <= currentPhaseIndex, current: i === currentPhaseIndex }"
        >
          <div class="dot"></div>
          <div class="label">{{ t(s.label) }}</div>
        </div>
      </div>
      <div class="progress">
        <div class="bar">
          <div class="fill" :style="{ width: percent + '%' }">
            <div class="gloss"></div>
          </div>
          <div class="percentText">{{ percent }}%</div>
        </div>
        <div class="progress-details">
          <template v-if="phase === 'checking'">
            <span>{{ t('客户端数量') }}: {{ progressDetails.clientCount ?? '-' }}</span>
            <span class="sep">|</span>
            <span>{{ t('服务端数量') }}: {{ progressDetails.serverCount ?? '-' }}</span>
          </template>
          <template v-else-if="phase === 'diffing'">
            <span>{{ t('待上传') }}: {{ progressDetails.toAddCount ?? 0 }}</span>
          </template>
          <template v-else-if="phase === 'pulling'">
            <span>{{ t('已拉取页') }}: {{ progressDetails.pulledPages ?? 0 }}</span>
            <span class="sep">/</span>
            <span>{{ t('总页数') }}: {{ progressDetails.totalPages ?? 0 }}</span>
          </template>
        </div>
      </div>
      <div class="actions">
        <div
          class="button"
          :class="{ disabled: syncing }"
          style="
            margin-right: 10px;
            width: 90px;
            text-align: center;
            height: 25px;
            line-height: 25px;
          "
          @click="startSync"
        >
          {{ t('开始同步') }}
        </div>
        <div
          class="button"
          style="width: 90px; text-align: center; height: 25px; line-height: 25px"
          @click="$emit('cancel')"
        >
          {{ t('关闭') }} (Esc)
        </div>
      </div>
      <div class="log" v-if="logMsg">{{ logMsg }}</div>
    </div>
  </div>
  <div class="dialog unselectable" v-if="summary">
    <div class="inner">
      <div class="title">{{ t('同步完成') }}</div>
      <div class="stats">
        <div class="section">
          <div class="section-title">{{ t('结果概览') }}</div>
          <div class="chips">
            <div class="chip" :class="{ success: (summary.addedToServerCount || 0) > 0 }">
              <div class="num">{{ summary.addedToServerCount }}</div>
              <div class="cap">{{ t('上行新增') }}</div>
            </div>
            <div class="chip" :class="{ success: (summary.pulledToClientCount || 0) > 0 }">
              <div class="num">{{ summary.pulledToClientCount }}</div>
              <div class="cap">{{ t('下行拉取') }}</div>
            </div>
            <div class="chip">
              <div class="num">{{ formatDurationSec(summary.durationMs) }}</div>
              <div class="cap">{{ t('耗时') }} ({{ t('秒') }})</div>
            </div>
          </div>
        </div>
        <div class="section">
          <div class="section-title">{{ t('总量变化') }}</div>
          <div class="section-body">
            <span class="count-pair">
              <span class="count-text">{{ t('客户端') }}: {{ summary.clientInitialCount }}</span>
              <span class="arrow" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M5 12h12M13 6l6 6-6 6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  ></path>
                </svg>
              </span>
              <span class="count-text">{{ summary.totalClientCountAfter }}</span>
            </span>
            <span class="count-pair" style="margin-left: 16px">
              <span class="count-text">{{ t('服务端') }}: {{ summary.serverInitialCount }}</span>
              <span class="arrow" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M5 12h12M13 6l6 6-6 6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  ></path>
                </svg>
              </span>
              <span class="count-text">{{ summary.totalServerCountAfter }}</span>
            </span>
          </div>
        </div>
      </div>
      <div class="actions">
        <div class="button" @click="closeSummaryAndCancel">
          {{ t('关闭') }}
        </div>
      </div>
    </div>
  </div>
</template>
<style scoped lang="scss">
.inner {
  width: 520px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.title {
  text-align: center;
  font-weight: bold;
  color: #e5e5e5;
}
.stages {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.stage {
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0.6;
}
.stage .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3a3a3a;
}
.stage .label {
  font-size: 11px;
  color: #bdbdbd;
  white-space: nowrap;
}
.stage.active {
  opacity: 1;
}
.stage.active .dot {
  background: #4da3ff;
}
.stage.current .dot {
  background: #3a7afe;
}

.progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bar {
  position: relative;
  height: 10px;
  background: #1f1f1f;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid #2c2c2c;
}
.fill {
  position: relative;
  height: 100%;
  background: linear-gradient(90deg, #3a7afe, #4da3ff);
  background-size: 200% 100%;
  animation: slideBg 2.2s linear infinite;
}
.fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image: repeating-linear-gradient(
    45deg,
    rgba(255, 255, 255, 0.12) 0 8px,
    rgba(255, 255, 255, 0.04) 8px 16px
  );
  mix-blend-mode: overlay;
  animation: moveStripes 1.2s linear infinite;
}
.gloss {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0.25) 50%,
    rgba(255, 255, 255, 0) 100%
  );
  transform: translateX(-100%);
  animation: shine 2.8s ease-in-out infinite;
}
.percentText {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  color: #e5e5e5;
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
.phase {
  text-align: center;
  font-size: 12px;
  color: #cfcfcf;
}
.progress-details {
  text-align: center;
  font-size: 11px;
  color: #a8a8a8;
}
.progress-details .sep {
  margin: 0 6px;
  color: #5a5a5a;
}
.actions {
  display: flex;
  justify-content: center;
  gap: 0;
  padding-top: 10px;
}
.disabled {
  opacity: 0.6;
  pointer-events: none;
}
.hint {
  text-align: center;
  color: #ffcc66;
  font-size: 12px;
}
.log {
  text-align: center;
  font-size: 12px;
  color: #aaa;
}
.report {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #d0d0d0;
}
.stats {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 12px;
  color: #d0d0d0;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.row .label {
  width: 90px;
  min-width: 90px;
  text-align: right;
  color: #bdbdbd;
}
.row .value {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.section-title {
  font-size: 13px;
  color: #d0d0d0;
  font-weight: 700;
  letter-spacing: 0.2px;
}
.section-body {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.chips {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.chip {
  min-width: 96px;
  padding: 8px 10px;
  border: 1px solid #2c2c2c;
  border-radius: 6px;
  background: #202020;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
}
.chip .num {
  font-size: 18px;
  color: #e5e5e5;
  font-weight: 700;
  line-height: 1;
}
.chip .cap {
  font-size: 11px;
  color: #a8a8a8;
  margin-top: 4px;
}
.chip.success .num {
  color: #9fe870;
}
.count-pair {
  display: inline-flex;
  align-items: center;
  line-height: 14px;
  height: 14px;
}
.count-pair > .count-text {
  display: inline-flex;
  align-items: center;
  line-height: 14px;
  height: 14px;
}
.arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin: 0 6px;
  line-height: 14px;
  vertical-align: middle;
}
.arrow svg {
  width: 14px;
  height: 14px;
  display: block;
}
.count-pair {
  display: inline-flex;
  align-items: center;
}
.count-pair > .count-text {
  display: inline-flex;
  align-items: center;
  line-height: 1.2;
  height: 14px;
}
.arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin: 0 6px;
  line-height: 14px;
  vertical-align: middle;
}
.arrow svg {
  width: 14px;
  height: 14px;
  display: block;
}
.big {
  font-size: 14px;
  color: #e5e5e5;
  font-weight: 600;
}
.muted {
  color: #a8a8a8;
}
.link {
  color: #4da3ff;
  cursor: pointer;
  user-select: none;
}
</style>
