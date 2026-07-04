<script setup lang="ts">
defineProps<{
  coverBlobUrl: string
  placeholderSrc: string
}>()

const emit = defineEmits<{
  (event: 'hover-cover'): void
}>()
</script>

<template>
  <div class="player-cover-slot unselectable">
    <div class="player-cover-slot__anchor" @mouseenter="emit('hover-cover')">
      <transition name="cover-switch" mode="out-in">
        <img
          v-if="coverBlobUrl"
          :key="coverBlobUrl"
          :src="coverBlobUrl"
          class="player-cover-slot__cover"
        />
        <img
          v-else
          :key="'placeholder'"
          :src="placeholderSrc"
          class="player-cover-slot__placeholder"
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
