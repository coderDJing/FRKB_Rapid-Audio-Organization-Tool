<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick, computed, getCurrentInstance } from 'vue'
import type { PropType } from 'vue'
import shortcutIcon from '@renderer/assets/shortcutIcon.png?asset'
import { t } from '@renderer/utils/translate'

type BoundaryType = 'window' | 'element'

const props = defineProps({
  // 触发气泡的锚点 DOM
  dom: {
    type: Object as PropType<HTMLElement | null>,
    default: null
  },
  // 标题（若未提供默认插槽，则使用标题+快捷键信息的布局）
  title: {
    type: String,
    default: ''
  },
  // 快捷键信息（可选）
  shortcut: {
    type: String,
    default: ''
  },
  // 显示/隐藏延迟（毫秒）
  showDelay: {
    type: Number,
    default: 500
  },
  hideDelay: {
    type: Number,
    default: 80
  },
  // 边界感知：窗口或指定元素
  boundary: {
    type: String as PropType<BoundaryType>,
    default: 'window'
  },
  boundaryEl: {
    type: Object as PropType<HTMLElement | null>,
    default: null
  },
  // 偏移距离
  offset: {
    type: Number,
    default: 8
  },
  // 最大宽度（自动换行），高度自适应
  maxWidth: {
    type: Number,
    default: 280
  },
  // 是否跟随鼠标移动定位（默认不跟随，只锚定到触发元素）
  followMouse: {
    type: Boolean,
    default: false
  },
  // 层级
  zIndex: {
    type: Number,
    default: 200
  },
  // 仅当锚点元素内容发生溢出（如被省略号遮挡）时才显示气泡
  onlyWhenOverflow: {
    type: Boolean,
    default: false
  }
})

const visible = ref(false)
const bubbleEl = ref<HTMLDivElement | null>(null)
const topPx = ref(0)
const leftPx = ref(0)
const hoverTimer = ref<NodeJS.Timeout | null>(null)
const hideTimer = ref<NodeJS.Timeout | null>(null)
const mouseX = ref<number | null>(null)
const mouseY = ref<number | null>(null)

const hasDefaultSlot = computed(() => {
  // 避免在 setup 直接使用 useSlots 导致类型提示缺失
  // 运行时从实例上获取 slots
  try {
    // @ts-ignore
    const slots = (getCurrentInstance && getCurrentInstance()?.slots) || undefined
    return !!slots?.default
  } catch {
    return false
  }
})

function clearTimers() {
  if (hoverTimer.value) {
    clearTimeout(hoverTimer.value)
    hoverTimer.value = null
  }
  if (hideTimer.value) {
    clearTimeout(hideTimer.value)
    hideTimer.value = null
  }
}

function onAnchorMouseEnter(e: MouseEvent) {
  if (hideTimer.value) {
    clearTimeout(hideTimer.value)
    hideTimer.value = null
  }
  // 记录进入时的鼠标坐标，避免延时期间位置偏差
  mouseX.value = e.clientX
  mouseY.value = e.clientY
  if (hoverTimer.value) clearTimeout(hoverTimer.value)
  hoverTimer.value = setTimeout(async () => {
    // 若要求仅在文本溢出时显示，则进行判断
    if (props.onlyWhenOverflow && props.dom) {
      const el = props.dom as HTMLElement
      const isOverflow = el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight
      if (!isOverflow) {
        return
      }
    }
    visible.value = true
    await nextTick()
    updatePosition()
    // 再次确保隐藏计时器被清理，防止竞态
    if (hideTimer.value) {
      clearTimeout(hideTimer.value)
      hideTimer.value = null
    }
  }, props.showDelay)
}

function onAnchorMouseLeave(e: MouseEvent) {
  if (hoverTimer.value) {
    clearTimeout(hoverTimer.value)
    hoverTimer.value = null
  }
  if (hideTimer.value) clearTimeout(hideTimer.value)
  const rt = (e && (e.relatedTarget as Node | null)) || null
  // 若移入的是气泡本身或其子元素，则不触发隐藏
  if (rt && bubbleEl.value && bubbleEl.value.contains(rt)) {
    return
  }
  hideTimer.value = setTimeout(() => {
    visible.value = false
  }, props.hideDelay)
}

function onAnchorMouseMove(e: MouseEvent) {
  // 总是记录最新鼠标位置
  mouseX.value = e.clientX
  mouseY.value = e.clientY
  // 仅在需要跟随且已显示时才实时更新
  if (props.followMouse && visible.value) updatePosition()
}

function onBubbleMouseEnter() {
  if (hideTimer.value) {
    clearTimeout(hideTimer.value)
    hideTimer.value = null
  }
}

function onBubbleMouseLeave() {
  if (hideTimer.value) clearTimeout(hideTimer.value)
  hideTimer.value = setTimeout(() => {
    visible.value = false
  }, props.hideDelay)
}

function getBoundaryRect(): DOMRect {
  if (props.boundary === 'element' && props.boundaryEl) {
    return props.boundaryEl.getBoundingClientRect()
  }
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight)
}

function getAnchorBasePoint() {
  const boundary = getBoundaryRect()
  if (mouseX.value !== null && mouseY.value !== null) {
    return { x: mouseX.value, y: mouseY.value, boundary }
  }
  if (props.dom) {
    const rect = props.dom.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    return { x, y, boundary }
  }
  return { x: boundary.left + boundary.width / 2, y: boundary.top + boundary.height / 2, boundary }
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function updatePosition() {
  const el = bubbleEl.value
  if (!el) return
  const { x, y, boundary } = getAnchorBasePoint()
  // 先确保元素渲染后再量尺寸
  const w = el.offsetWidth
  const h = el.offsetHeight
  const leftSpace = x - boundary.left
  const rightSpace = boundary.right - x
  const topSpace = y - boundary.top
  const bottomSpace = boundary.bottom - y

  const verticalOrder = bottomSpace >= topSpace ? ['bottom', 'top'] : ['top', 'bottom']
  const horizontalOrder = rightSpace >= leftSpace ? ['right', 'left'] : ['left', 'right']

  type V = 'top' | 'bottom'
  type H = 'left' | 'right'
  const candidates: Array<{ v: V; h: H }> = []
  for (const v of verticalOrder as V[]) {
    for (const hDir of horizontalOrder as H[]) {
      candidates.push({ v, h: hDir })
    }
  }

  let finalTop = 0
  let finalLeft = 0
  let placed = false
  // 若锚点来自鼠标，则消除额外偏移，避免鼠标与气泡之间出现可见间隙
  const effectiveOffset = mouseX.value !== null && mouseY.value !== null ? 0 : props.offset

  for (const c of candidates) {
    const t = c.v === 'bottom' ? y + effectiveOffset : y - h - effectiveOffset
    const l = c.h === 'right' ? x + effectiveOffset : x - w - effectiveOffset
    const fits =
      t >= boundary.top && l >= boundary.left && t + h <= boundary.bottom && l + w <= boundary.right
    if (fits) {
      finalTop = t
      finalLeft = l
      placed = true
      break
    }
  }

  if (!placed) {
    // 若都不完全适配，则对当前优先方向进行 clamp
    const v = verticalOrder[0] as V
    const hDir = horizontalOrder[0] as H
    const t = v === 'bottom' ? y + effectiveOffset : y - h - effectiveOffset
    const l = hDir === 'right' ? x + effectiveOffset : x - w - effectiveOffset
    finalTop = clamp(t, boundary.top, boundary.bottom - h)
    finalLeft = clamp(l, boundary.left, boundary.right - w)
  }

  topPx.value = Math.round(finalTop)
  leftPx.value = Math.round(finalLeft)
}

function addAnchorListeners(anchor: HTMLElement | null) {
  if (!anchor) return
  anchor.addEventListener('mouseenter', onAnchorMouseEnter)
  anchor.addEventListener('mouseleave', onAnchorMouseLeave)
  anchor.addEventListener('mousemove', onAnchorMouseMove)
}

function removeAnchorListeners(anchor: HTMLElement | null) {
  if (!anchor) return
  anchor.removeEventListener('mouseenter', onAnchorMouseEnter)
  anchor.removeEventListener('mouseleave', onAnchorMouseLeave)
  anchor.removeEventListener('mousemove', onAnchorMouseMove)
}

watch(
  () => props.dom,
  (newEl, oldEl) => {
    removeAnchorListeners(oldEl as HTMLElement | null)
    addAnchorListeners(newEl as HTMLElement | null)
  },
  { immediate: true }
)

onMounted(() => {
  window.addEventListener('scroll', updatePosition, true)
  window.addEventListener('resize', updatePosition, { passive: true } as any)
})

onUnmounted(() => {
  window.removeEventListener('scroll', updatePosition, true)
  window.removeEventListener('resize', updatePosition as any)
  removeAnchorListeners(props.dom)
  clearTimers()
})
</script>

<template>
  <teleport to="body">
    <transition name="fade">
      <div
        v-if="visible"
        ref="bubbleEl"
        class="frkb-bubble"
        :style="{
          top: topPx + 'px',
          left: leftPx + 'px',
          maxWidth: maxWidth + 'px',
          zIndex: zIndex
        }"
        @mouseenter="onBubbleMouseEnter"
        @mouseleave="onBubbleMouseLeave"
      >
        <template v-if="hasDefaultSlot">
          <slot />
        </template>
        <template v-else>
          <div class="frkb-bubble-row">
            <span>{{ title }}</span>
            <div v-if="shortcut" class="frkb-bubble-shortcut">
              <img :src="shortcutIcon" :draggable="false" alt="" />
              <span>{{ shortcut }}</span>
            </div>
          </div>
        </template>
      </div>
    </transition>
  </teleport>
</template>

<style scoped lang="scss">
.frkb-bubble {
  position: fixed;
  background-color: #202020;
  color: #d0d0d0;
  border: 1px solid #424242;
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.4;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  pointer-events: auto;
  user-select: text;
}

.frkb-bubble-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.frkb-bubble-shortcut {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  img {
    width: 16px;
    height: 16px;
  }
}
</style>
