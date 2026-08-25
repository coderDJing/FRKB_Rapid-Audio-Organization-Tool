<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    slotSize?: number
    coverSize?: number
    placeholderSize?: number
    coverBlobUrl: string
    placeholderSrc: string
  }>(),
  {
    slotSize: 62,
    coverSize: 52,
    placeholderSize: 28
  }
)

const emit = defineEmits<{
  (event: 'hover-cover'): void
  (event: 'leave-cover'): void
}>()

/*
 * Keep the cover slot reusable by the main player and the compact window. The
 * main player keeps its existing dimensions while the compact window can use
 * a smaller stable slot without duplicating this component.
 */
const slotStyle = () => ({
  width: `${props.slotSize}px`,
  height: `${props.slotSize}px`,
  flex: `0 0 ${props.slotSize}px`
})

const coverStyle = () => ({
  width: `${props.coverSize}px`,
  height: `${props.coverSize}px`
})

const placeholderStyle = () => ({
  width: `${props.placeholderSize}px`,
  height: `${props.placeholderSize}px`
})
</script>

<template>
  <div class="player-cover-slot unselectable" :style="slotStyle()">
    <div
      class="player-cover-slot__anchor"
      :style="slotStyle()"
      @mouseenter="emit('hover-cover')"
      @mouseleave="emit('leave-cover')"
    >
      <transition name="cover-switch" mode="out-in">
        <img
          v-if="coverBlobUrl"
          :key="coverBlobUrl"
          :src="coverBlobUrl"
          class="player-cover-slot__cover"
          :style="coverStyle()"
        />
        <img
          v-else
          :key="'placeholder'"
          :src="placeholderSrc"
          class="player-cover-slot__placeholder"
          :style="placeholderStyle()"
        />
      </transition>
    </div>
  </div>
</template>

<style scoped lang="scss">
.player-cover-slot {
  flex: 0 0 62px;
}

.player-cover-slot,
.player-cover-slot__anchor {
  display: flex;
  width: 62px;
  height: 62px;
}

.player-cover-slot__anchor {
  align-items: center;
  justify-content: center;
}

.player-cover-slot__cover {
  width: 52px;
  height: 52px;
}

.player-cover-slot__placeholder {
  width: 28px;
  height: 28px;
}

.cover-switch-enter-active,
.cover-switch-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.cover-switch-enter-from,
.cover-switch-leave-to {
  opacity: 0;
  transform: scale(0.9);
}

@media (prefers-reduced-motion: reduce) {
  .cover-switch-enter-active,
  .cover-switch-leave-active {
    transition: none;
  }
}
</style>
