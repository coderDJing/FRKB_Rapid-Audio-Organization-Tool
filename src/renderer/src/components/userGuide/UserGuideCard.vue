<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, toRef } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '@renderer/utils/utils'
import { t } from '@renderer/utils/translate'
import { getUserGuideCardCopy } from '@renderer/composables/userGuideCopy'
import { useUserGuideSpotlight } from '@renderer/composables/useUserGuideSpotlight'
import {
  USER_GUIDE_DEFAULT_BEAT_ID,
  type UserGuideBeatId,
  type UserGuideStepId
} from '@shared/userGuide'

const props = defineProps<{
  step: UserGuideStepId
  beat?: UserGuideBeatId
  rekordboxUser: boolean
  beatNumber?: number
  beatCount?: number
  hasNext?: boolean
}>()

const emit = defineEmits<{
  next: []
  skip: []
}>()

const uuid = uuidV4()
const panelEl = ref<HTMLElement | null>(null)
const stepRef = toRef(props, 'step')
const beatRef = computed(() => props.beat || USER_GUIDE_DEFAULT_BEAT_ID)
const rekordboxUserRef = toRef(props, 'rekordboxUser')
const {
  hole,
  retriesExhausted,
  panelStyle,
  arrowSide,
  panelWidth,
  holeRadius,
  viewWidth,
  viewHeight,
  maskPath,
  update
} = useUserGuideSpotlight(stepRef, beatRef, rekordboxUserRef, panelEl)
const copy = computed(() => getUserGuideCardCopy(props.step, beatRef.value, props.rekordboxUser))
const showProgress = computed(() => (props.beatCount || 1) > 1)
const showSpotlight = computed(() => Boolean(hole.value) || retriesExhausted.value)
const progressText = computed(() =>
  t('userGuide.progress', {
    current: props.beatNumber || 1,
    total: props.beatCount || 1
  })
)
const primaryLabel = computed(() => (props.hasNext ? t('userGuide.next') : t('userGuide.gotIt')))
const holeStyle = computed(() => {
  if (!hole.value) return {}
  return {
    left: `${Math.round(hole.value.x)}px`,
    top: `${Math.round(hole.value.y)}px`,
    width: `${Math.round(hole.value.w)}px`,
    height: `${Math.round(hole.value.h)}px`,
    borderRadius: `${holeRadius}px`
  }
})

const goNext = () => emit('next')
const skip = () => emit('skip')
const spotlightEl = ref<HTMLElement | null>(null)

const setHtmlDragActive = (active: boolean) => {
  spotlightEl.value?.classList.toggle('is-html-drag-active', active)
}

const handleHtmlDragStart = () => setHtmlDragActive(true)
const handleHtmlDragFinish = () => setHtmlDragActive(false)

onMounted(() => {
  hotkeys('Enter,E', uuid, () => {
    if (!showSpotlight.value) return false
    goNext()
    return false
  })
  hotkeys('Esc', uuid, () => {
    if (!showSpotlight.value) return false
    skip()
    return false
  })
  utils.setHotkeysScpoe(uuid)
  window.addEventListener('dragstart', handleHtmlDragStart, true)
  window.addEventListener('dragend', handleHtmlDragFinish, true)
  window.addEventListener('drop', handleHtmlDragFinish, true)
  void nextTick(() => {
    update()
  })
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  window.removeEventListener('dragstart', handleHtmlDragStart, true)
  window.removeEventListener('dragend', handleHtmlDragFinish, true)
  window.removeEventListener('drop', handleHtmlDragFinish, true)
  setHtmlDragActive(false)
})
</script>

<template>
  <div
    ref="spotlightEl"
    class="user-guide-spotlight unselectable"
    :class="{ 'is-pending': !showSpotlight }"
    role="dialog"
    aria-modal="true"
  >
    <template v-if="showSpotlight">
      <svg
        class="user-guide-mask"
        :viewBox="`0 0 ${viewWidth} ${viewHeight}`"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path :d="maskPath" fill-rule="evenodd" @click="goNext" />
      </svg>
      <div v-if="hole" class="user-guide-hole" :style="holeStyle" aria-hidden="true">
        <div class="user-guide-hole__ring"></div>
        <div class="user-guide-hole__pulse"></div>
      </div>
      <div
        ref="panelEl"
        class="user-guide-panel"
        :class="`user-guide-panel--arrow-${arrowSide}`"
        :style="{ width: `${panelWidth}px`, ...panelStyle }"
      >
        <div v-if="copy.kicker || showProgress" class="user-guide-panel__meta">
          <div v-if="copy.kicker" class="user-guide-panel__kicker">{{ copy.kicker }}</div>
          <div v-if="showProgress" class="user-guide-panel__progress">{{ progressText }}</div>
        </div>
        <div class="user-guide-panel__title">{{ copy.title }}</div>
        <p v-for="(line, index) in copy.lines" :key="index" class="user-guide-panel__line">
          {{ line }}
        </p>
        <p v-if="copy.hint" class="user-guide-panel__hint">
          {{ copy.hint }}
        </p>
        <div class="user-guide-panel__actions">
          <div v-if="showProgress && hasNext" class="button" @click="skip">
            {{ t('userGuide.skip') }}
          </div>
          <div class="button" @click="goNext">{{ primaryLabel }}</div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.user-guide-spotlight {
  position: fixed;
  inset: 0;
  z-index: var(--z-blocking-overlay);
  pointer-events: none;
}

.user-guide-spotlight.is-pending {
  visibility: hidden;
}

.user-guide-mask {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  color: var(--user-guide-mask);
  pointer-events: none;
}

.user-guide-mask path {
  fill: currentColor;
  pointer-events: fill;
  cursor: default;
}

.user-guide-spotlight.is-html-drag-active .user-guide-mask path {
  pointer-events: none;
}

.user-guide-hole {
  position: absolute;
  pointer-events: none;
}

.user-guide-hole__ring {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  border-radius: inherit;
  border: 2px solid var(--accent);
  box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 42%, transparent);
}

.user-guide-hole__pulse {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  border-radius: inherit;
  border: 2px solid color-mix(in srgb, var(--accent) 80%, transparent);
  animation: user-guide-pulse 1.8s ease-out infinite;
}

.user-guide-panel {
  position: absolute;
  z-index: 1;
  pointer-events: auto;
  box-sizing: border-box;
  padding: 16px 18px 14px;
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  border-radius: 10px;
  background: var(--user-guide-panel);
  color: var(--text);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(12px);
}

.user-guide-panel__meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}

.user-guide-panel__kicker {
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--accent);
}

.user-guide-panel__progress {
  font-size: 11px;
  color: var(--text-weak);
  white-space: nowrap;
}

.user-guide-panel__title {
  margin-bottom: 8px;
  font-size: 16px;
  font-weight: 600;
}

.user-guide-panel__line {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.55;
}

.user-guide-panel__hint {
  margin: 2px 0 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-weak);
}

.user-guide-panel__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.user-guide-panel::before {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  background: var(--user-guide-panel);
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  transform: rotate(45deg);
}

.user-guide-panel--arrow-none::before {
  display: none;
}

.user-guide-panel--arrow-left::before {
  left: -7px;
  top: calc(var(--user-guide-arrow-offset, 22px) - 6px);
  border-right: none;
  border-top: none;
}

.user-guide-panel--arrow-right::before {
  right: -7px;
  top: calc(var(--user-guide-arrow-offset, 22px) - 6px);
  border-left: none;
  border-bottom: none;
}

.user-guide-panel--arrow-top::before {
  top: -7px;
  left: calc(var(--user-guide-arrow-offset, 22px) - 6px);
  border-right: none;
  border-bottom: none;
}

.user-guide-panel--arrow-bottom::before {
  bottom: -7px;
  left: calc(var(--user-guide-arrow-offset, 22px) - 6px);
  border-left: none;
  border-top: none;
}

@keyframes user-guide-pulse {
  0% {
    transform: scale(1);
    opacity: 0.72;
  }
  100% {
    transform: scale(1.16);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .user-guide-hole__pulse {
    animation: none;
    display: none;
  }
}
</style>
