<script setup lang="ts">
import { computed, ref, watch, useTemplateRef } from 'vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { getKeyDisplayText } from '@shared/keyDisplay'

// 组件用于显示 BPM，并支持通过左键点击节拍来计算 BPM，右键恢复系统分析值
const props = defineProps<{
  // 系统自动分析得到的 BPM 值（可能为 number、字符串 'N/A' 或空字符串）
  bpm: number | string
  // 与父级保持一致的可见控制
  waveformShow: boolean
  // 调性文本（Mixxx 口径）
  keyText?: string
}>()

// 是否处于手动点击（Tap Tempo）模式
const isManual = ref(false)
// 手动计算得到的 BPM（保留一位小数）
const manualBpm = ref<number | null>(null)
// 最近的点击时间戳（毫秒）
const tapTimestamps = ref<number[]>([])

// 提示气泡绑定 DOM
const bpmDomRef = useTemplateRef<HTMLDivElement>('bpmDomRef')
const runtime = useRuntimeStore()

// 当系统 BPM 变化（如切歌或重新分析）时，自动退出手动模式
watch(
  () => props.bpm,
  () => {
    resetManual()
  }
)

// 将显示值统一成字符串
const displayValue = computed<string>(() => {
  let bpmText = ''
  if (isManual.value && manualBpm.value !== null) {
    bpmText = manualBpm.value.toFixed(1)
  } else if (typeof props.bpm === 'number') {
    bpmText = props.bpm.toString()
  } else {
    bpmText = props.bpm || ''
  }

  const rawKey = typeof props.keyText === 'string' ? props.keyText.trim() : ''
  let keyText = ''
  if (!rawKey) {
    keyText = ''
  } else if (rawKey.toLowerCase() === 'o') {
    keyText = '-'
  } else {
    const style = (runtime.setting as any).keyDisplayStyle === 'Camelot' ? 'Camelot' : 'Classic'
    keyText = getKeyDisplayText(rawKey, style)
  }

  if (bpmText === '' && keyText === '') return ''
  return `${bpmText}/${keyText}`
})

// 左键点击：加入一次节拍点击并重新计算 BPM
const handleLeftClick = () => {
  const now = Date.now()

  // 如果距离上次点击过久，则从头开始
  const last = tapTimestamps.value[tapTimestamps.value.length - 1]
  if (last && now - last > 2000) {
    tapTimestamps.value = []
  }

  tapTimestamps.value.push(now)

  // 仅保留最近 8 次点击（约 7 个间隔），更平滑，通常 2~4 秒得到稳定近似
  if (tapTimestamps.value.length > 8) {
    tapTimestamps.value = tapTimestamps.value.slice(-8)
  }

  if (tapTimestamps.value.length >= 2) {
    // 计算相邻时间差（ms）
    const deltas: number[] = []
    for (let i = 1; i < tapTimestamps.value.length; i++) {
      const delta = tapTimestamps.value[i] - tapTimestamps.value[i - 1]
      // 过滤异常的长间隔，避免拖慢平均值
      if (delta > 50 && delta < 2000) {
        deltas.push(delta)
      }
    }

    if (deltas.length > 0) {
      // 仅取最近的间隔（窗口已限制至 5 taps，最多 4 个间隔）
      const recent = deltas
      const avgMs = recent.reduce((a, b) => a + b, 0) / recent.length
      const bpm = 60000 / avgMs
      manualBpm.value = Math.max(1, Math.min(999, Number(bpm.toFixed(1))))
      isManual.value = true
    }
  }
}

// 右键点击：恢复系统 BPM
const handleRightClick = (e: MouseEvent) => {
  e.preventDefault()
  resetManual()
}

const resetManual = () => {
  isManual.value = false
  manualBpm.value = null
  tapTimestamps.value = []
}
</script>

<template>
  <div
    class="unselectable"
    ref="bpmDomRef"
    :style="{
      width: 'auto',
      minWidth: '80px',
      padding: '0 6px',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      fontSize: '16px',
      fontWeight: 'bold',
      // 手动 BPM 高亮为主题色
      color: isManual ? '#0078d4' : undefined
    }"
    v-show="waveformShow"
    @click.left="handleLeftClick"
    @contextmenu="handleRightClick"
  >
    {{ displayValue }}
  </div>
  <bubbleBox
    :dom="bpmDomRef || undefined"
    title="BPM"
    :shortcut="t('player.tapBeat')"
    :maxWidth="250"
  />
</template>

<style scoped></style>
