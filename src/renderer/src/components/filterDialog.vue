<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'

type Op = 'eq' | 'gte' | 'lte'

const props = defineProps<{
  type: 'text' | 'duration'
  initText?: string
  initOp?: Op
  initDuration?: string
}>()

const emits = defineEmits<{
  (
    e: 'confirm',
    payload: { type: 'text'; text: string } | { type: 'duration'; op: Op; duration: string }
  ): void
  (e: 'cancel'): void
  (e: 'clear'): void
}>()

const uuid = uuidV4()

const text = ref(props.initText || '')
const op = ref<Op>(props.initOp || 'gte')
const duration = ref(props.initDuration || '00:00')

watch(
  () => [props.initText, props.initOp, props.initDuration, props.type],
  () => {
    text.value = props.initText || ''
    op.value = props.initOp || 'gte'
    duration.value = props.initDuration || '00:00'
  }
)

function normalizeMmSs(input: string): string {
  if (!input) return '00:00'
  const parts = String(input).split(':')
  let m = 0
  let s = 0
  if (parts.length >= 1) m = Number((parts[0] || '').replace(/\D/g, '')) || 0
  if (parts.length >= 2) s = Number((parts[1] || '').replace(/\D/g, '')) || 0
  if (s > 59) s = 59
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return `${mm}:${ss}`
}

const handleConfirm = () => {
  if (props.type === 'text') {
    emits('confirm', { type: 'text', text: text.value.trim() })
  } else {
    emits('confirm', { type: 'duration', op: op.value, duration: normalizeMmSs(duration.value) })
  }
}
const handleCancel = () => emits('cancel')
const handleClear = () => emits('clear')

onMounted(() => {
  // 切换热键作用域，防止与全局热键干扰
  utils.setHotkeysScpoe(uuid)
  hotkeys('E,Enter', uuid, () => {
    handleConfirm()
    return false
  })
  hotkeys('Q', uuid, () => {
    handleClear()
    return false
  })
  hotkeys('Esc', uuid, () => {
    handleCancel()
    return false
  })
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div class="dialog unselectable" style="font-size: 14px; color: #cccccc">
    <div
      class="inner"
      style="
        width: 420px;
        min-height: 240px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      "
    >
      <div>
        <div style="text-align: center; height: 30px; line-height: 30px; font-size: 14px">
          <span style="font-weight: bold">{{
            props.type === 'text' ? t('filters.filterByText') : t('filters.filterByDuration')
          }}</span>
        </div>
        <div style="padding: 10px 20px 10px 20px">
          <template v-if="props.type === 'text'">
            <input
              v-model="text"
              class="filter-input"
              type="text"
              :placeholder="t('filters.keywordPlaceholder')"
              style="width: 100%"
            />
          </template>
          <template v-else>
            <div class="radio-group">
              <label class="radio"
                ><input type="radio" value="gte" v-model="op" /><span class="dot"></span
                >{{ t('filters.greaterOrEqual') }}</label
              >
              <label class="radio"
                ><input type="radio" value="lte" v-model="op" /><span class="dot"></span
                >{{ t('filters.lessOrEqual') }}</label
              >
              <label class="radio"
                ><input type="radio" value="eq" v-model="op" /><span class="dot"></span
                >{{ t('filters.equals') }}</label
              >
            </div>
            <input
              v-model="duration"
              @blur="duration = normalizeMmSs(duration)"
              class="filter-input"
              type="text"
              :placeholder="t('filters.durationPlaceholder')"
              style="width: 100%"
            />
            <div style="margin-top: 8px; display: flex; gap: 8px">
              <div class="tag" @click="duration = '01:30'">01:30</div>
              <div class="tag" @click="duration = '03:00'">03:00</div>
              <div class="tag" @click="duration = '05:00'">05:00</div>
            </div>
          </template>
        </div>
      </div>
      <div style="display: flex; justify-content: center; padding: 0 20px 10px 20px; gap: 10px">
        <div class="button" style="width: 90px; text-align: center" @click="handleConfirm">
          {{ t('common.confirm') }} (E)
        </div>
        <div class="button" style="width: 120px; text-align: center" @click="handleClear">
          {{ t('filters.clearThisColumn') }} (Q)
        </div>
        <div class="button" style="width: 90px; text-align: center" @click="handleCancel">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.filter-input {
  height: 28px;
  border-radius: 4px;
  border: 1px solid #3a3a3a;
  background: #121212;
  color: #eaeaea;
  padding: 0 8px;
  box-sizing: border-box; /* 防止 width:100% 加上边框后溢出，保证左右视觉边距一致 */
  outline: none;
}
.radio-group {
  display: flex;
  gap: 16px;
  margin-bottom: 10px;
  color: #cccccc;
}
.radio {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.radio input[type='radio'] {
  /* 隐藏原生单选 */
  appearance: none;
  -webkit-appearance: none;
  width: 0;
  height: 0;
  position: absolute;
}
.radio .dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid #3a3a3a; /* 外圈边框保留 */
  background: transparent; /* 外圈无填充色 */
  position: relative;
  transition: all 0.15s ease;
}
.radio .dot::after {
  content: '';
  position: absolute;
  inset: 4px; /* 内圈更小 */
  border-radius: 50%;
  background: #0078d4; /* 内圈蓝色 */
  opacity: 0;
  transition: opacity 0.12s ease;
}
.radio input[type='radio']:checked + .dot::after {
  opacity: 1; /* 勾选时显示蓝色内圈 */
}
.radio:hover .dot {
  border-color: #5a5a5a; /* hover 时外圈边框微亮 */
  background: rgba(255, 255, 255, 0.02);
}
.tag {
  height: 24px;
  line-height: 24px;
  padding: 0 8px;
  border: 1px solid #3a3a3a;
  background: #191919;
  color: #cfcfcf;
  border-radius: 4px;
  cursor: pointer;
}
.button {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: #2d2e2e;
  font-size: 14px;
  user-select: none;
  cursor: pointer;
  &:hover {
    color: #ffffff;
    background-color: #3a3a3a;
  }
}
.dangerButton {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: #2d2e2e;
  font-size: 14px;
  user-select: none;
  cursor: pointer;
  &:hover {
    color: #ffffff;
    background-color: #e81123;
  }
}
</style>
