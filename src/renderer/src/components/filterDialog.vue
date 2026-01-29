<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'

type Op = 'eq' | 'gte' | 'lte'

const props = defineProps<{
  type: 'text' | 'duration' | 'bpm'
  initText?: string
  initExcludeText?: string
  initOp?: Op
  initDuration?: string
  initNumber?: string
}>()

const emits = defineEmits<{
  (
    e: 'confirm',
    payload:
      | { type: 'text'; text: string; excludeText: string }
      | { type: 'duration'; op: Op; duration: string }
      | { type: 'bpm'; op: Op; value: string }
  ): void
  (e: 'cancel'): void
  (e: 'clear'): void
}>()

const uuid = uuidV4()

const text = ref(props.initText || '')
const excludeText = ref(props.initExcludeText || '')
const op = ref<Op>(props.initOp || 'gte')
const duration = ref(props.initDuration || '00:00')
const numberValue = ref(props.initNumber || '')

watch(
  () => [
    props.initText,
    props.initExcludeText,
    props.initOp,
    props.initDuration,
    props.initNumber,
    props.type
  ],
  () => {
    text.value = props.initText || ''
    excludeText.value = props.initExcludeText || ''
    op.value = props.initOp || 'gte'
    duration.value = props.initDuration || '00:00'
    numberValue.value = props.initNumber || ''
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

function normalizeNumberInput(input: string): string {
  const raw = String(input || '').trim()
  if (!raw) return ''
  const cleaned = raw.replace(/[^0-9.]/g, '')
  if (!cleaned) return ''
  const parts = cleaned.split('.')
  return parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('')}` : parts[0]
}

const { dialogVisible, closeWithAnimation } = useDialogTransition()

const handleConfirm = () => {
  const payload =
    props.type === 'text'
      ? ({
          type: 'text',
          text: text.value.trim(),
          excludeText: excludeText.value.trim()
        } as const)
      : props.type === 'duration'
        ? ({ type: 'duration', op: op.value, duration: normalizeMmSs(duration.value) } as const)
        : ({ type: 'bpm', op: op.value, value: normalizeNumberInput(numberValue.value) } as const)
  closeWithAnimation(() => emits('confirm', payload))
}
const handleCancel = () => closeWithAnimation(() => emits('cancel'))
const handleClear = () => closeWithAnimation(() => emits('clear'))

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
  <div
    class="dialog unselectable"
    :class="{ 'dialog-visible': dialogVisible }"
    style="font-size: 14px; color: var(--text)"
  >
    <div
      class="inner"
      v-dialog-drag="'.dialog-title'"
      style="width: 420px; min-height: 240px; display: flex; flex-direction: column"
    >
      <div class="dialog-title dialog-header">
        <span>
          {{
            props.type === 'text'
              ? t('filters.filterByText')
              : props.type === 'duration'
                ? t('filters.filterByDuration')
                : t('filters.filterByBpm')
          }}
        </span>
      </div>
      <div style="padding: 10px 20px; flex: 1; overflow-y: auto">
        <template v-if="props.type === 'text'">
          <div class="filter-field">
            <div class="filter-label">{{ t('filters.includeKeyword') }}</div>
            <input
              v-model="text"
              class="filter-input"
              type="text"
              :placeholder="t('filters.keywordPlaceholder')"
              style="width: 100%"
            />
          </div>
          <div class="filter-field" style="margin-top: 10px">
            <div class="filter-label">{{ t('filters.excludeKeyword') }}</div>
            <input
              v-model="excludeText"
              class="filter-input"
              type="text"
              :placeholder="t('filters.excludeKeywordPlaceholder')"
              style="width: 100%"
            />
          </div>
        </template>
        <template v-else-if="props.type === 'duration'">
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
            v-model="numberValue"
            @blur="numberValue = normalizeNumberInput(numberValue)"
            class="filter-input"
            type="text"
            inputmode="decimal"
            :placeholder="t('filters.bpmPlaceholder')"
            style="width: 100%"
          />
        </template>
      </div>
      <div class="dialog-footer" style="padding: 10px 20px 18px; gap: 10px">
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
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  padding: 0 8px;
  box-sizing: border-box; /* 防止 width:100% 加上边框后溢出，保证左右视觉边距一致 */
  outline: none;

  &::placeholder {
    color: var(--text-weak);
  }
  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
  }
}
.filter-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.filter-label {
  font-size: 12px;
  color: var(--text-weak);
}
.radio-group {
  display: flex;
  gap: 16px;
  margin-bottom: 10px;
  color: var(--text);
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
  border: 1px solid var(--border); /* 外圈边框保留 */
  background: transparent; /* 外圈无填充色 */
  position: relative;
  transition: all 0.15s ease;
}
.radio .dot::after {
  content: '';
  position: absolute;
  inset: 4px; /* 内圈更小 */
  border-radius: 50%;
  background: var(--accent); /* 内圈蓝色 */
  opacity: 0;
  transition: opacity 0.12s ease;
}
.radio input[type='radio']:checked + .dot::after {
  opacity: 1; /* 勾选时显示蓝色内圈 */
}
.radio:hover .dot {
  border-color: var(--text-weak);
  background: rgba(0, 0, 0, 0.02);
}
.tag {
  height: 24px;
  line-height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }
}
.button {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: var(--hover);
  font-size: 14px;
  user-select: none;
  cursor: pointer;
  &:hover {
    color: #ffffff;
    background-color: var(--accent);
  }
}
.dangerButton {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: var(--hover);
  font-size: 14px;
  user-select: none;
  cursor: pointer;
  &:hover {
    color: #ffffff;
    background-color: #e81123;
  }
}
</style>
