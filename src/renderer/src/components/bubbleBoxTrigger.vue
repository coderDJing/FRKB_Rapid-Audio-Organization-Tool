<script setup lang="ts">
import { computed, getCurrentInstance, useAttrs, useTemplateRef } from 'vue'
import type { PropType } from 'vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'

defineOptions({
  inheritAttrs: false
})

type BoundaryType = 'window' | 'element'
type ScopedVNode = {
  scopeId?: string | null
  slotScopeIds?: string[] | null
}

const props = defineProps({
  tag: {
    type: String,
    default: 'div'
  },
  title: {
    type: String,
    default: ''
  },
  shortcut: {
    type: String,
    default: ''
  },
  showDelay: {
    type: Number,
    default: 500
  },
  hideDelay: {
    type: Number,
    default: 80
  },
  boundary: {
    type: String as PropType<BoundaryType>,
    default: 'window'
  },
  boundaryEl: {
    type: Object as PropType<HTMLElement | null>,
    default: null
  },
  offset: {
    type: Number,
    default: 8
  },
  maxWidth: {
    type: Number,
    default: 280
  },
  interactive: {
    type: Boolean,
    default: true
  },
  followMouse: {
    type: Boolean,
    default: false
  },
  zIndex: {
    type: [Number, String] as PropType<number | string>,
    default: 'var(--z-tooltip)'
  },
  onlyWhenOverflow: {
    type: Boolean,
    default: false
  },
  wrapperTag: {
    type: String,
    default: ''
  },
  wrapperClass: {
    type: [String, Array, Object] as PropType<unknown>,
    default: ''
  },
  wrapperStyle: {
    type: [String, Array, Object] as PropType<unknown>,
    default: ''
  }
})

const attrs = useAttrs()
const anchorRef = useTemplateRef<HTMLElement>('anchorRef')
const wrapperRef = useTemplateRef<HTMLElement>('wrapperRef')
const instance = getCurrentInstance()

const bubbleAnchorDom = computed(() =>
  props.wrapperTag ? (wrapperRef.value ?? anchorRef.value ?? null) : (anchorRef.value ?? null)
)

const inheritedScopeAttrs = computed<Record<string, string>>(() => {
  const vnode: ScopedVNode | undefined = instance?.vnode
  const scopeIds = [vnode?.scopeId, ...(vnode?.slotScopeIds ?? [])].filter(
    (scopeId): scopeId is string => typeof scopeId === 'string' && scopeId.length > 0
  )

  return Object.fromEntries(scopeIds.map((scopeId) => [scopeId, '']))
})

const anchorAttrs = computed<Record<string, unknown>>(() => ({
  ...attrs,
  ...inheritedScopeAttrs.value
}))

const resolvedWrapperStyle = computed(() => {
  if (props.wrapperTag === 'span') {
    return [{ display: 'inline-flex', minWidth: '0' }, props.wrapperStyle]
  }
  return props.wrapperStyle
})
</script>

<template>
  <component v-if="!wrapperTag" :is="tag" ref="anchorRef" v-bind="anchorAttrs">
    <slot />
  </component>
  <component
    v-else
    :is="wrapperTag"
    ref="wrapperRef"
    :class="wrapperClass"
    :style="resolvedWrapperStyle"
    v-bind="inheritedScopeAttrs"
  >
    <component :is="tag" ref="anchorRef" v-bind="anchorAttrs">
      <slot />
    </component>
  </component>
  <bubbleBox
    v-if="title"
    :dom="bubbleAnchorDom || undefined"
    :title="title"
    :shortcut="shortcut"
    :show-delay="showDelay"
    :hide-delay="hideDelay"
    :boundary="boundary"
    :boundary-el="boundaryEl"
    :offset="offset"
    :max-width="maxWidth"
    :interactive="interactive"
    :follow-mouse="followMouse"
    :z-index="zIndex"
    :only-when-overflow="onlyWhenOverflow"
  />
</template>
