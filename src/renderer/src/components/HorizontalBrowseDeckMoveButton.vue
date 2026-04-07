<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { t } from '@renderer/utils/translate'

type MoveSongsLibraryName = 'CuratedLibrary' | 'FilterLibrary' | 'MixtapeLibrary'

const props = defineProps<{
  disabled: boolean
  readOnlySource: boolean
}>()

const emit = defineEmits<{
  (event: 'select-target', target: MoveSongsLibraryName): void
}>()

const runtime = useRuntimeStore()
const menuUuid = `horizontal-browse-deck-move-${uuidV4()}`
const menuOpen = ref(false)

watch(
  () => runtime.activeMenuUUID,
  (value) => {
    if (value !== menuUuid) {
      menuOpen.value = false
    }
  }
)

const moveToFilterLabel = computed(() =>
  props.readOnlySource ? t('library.copyToFilter') : t('library.moveToFilter')
)
const moveToCuratedLabel = computed(() =>
  props.readOnlySource ? t('library.copyToCurated') : t('library.moveToCurated')
)
const addToMixtapeLabel = computed(() =>
  props.readOnlySource ? t('library.addToMixtapeByCopy') : t('library.addToMixtape')
)

const toggleMenu = () => {
  if (props.disabled) return
  if (menuOpen.value) {
    runtime.activeMenuUUID = ''
    menuOpen.value = false
    return
  }
  runtime.activeMenuUUID = menuUuid
  menuOpen.value = true
}

const handleSelectTarget = (target: MoveSongsLibraryName) => {
  runtime.activeMenuUUID = ''
  menuOpen.value = false
  emit('select-target', target)
}

onUnmounted(() => {
  if (runtime.activeMenuUUID === menuUuid) {
    runtime.activeMenuUUID = ''
  }
})
</script>

<template>
  <div class="deck-move-button" @click.stop>
    <button
      type="button"
      class="deck-move-button__trigger"
      :disabled="props.disabled"
      :class="{ 'is-open': menuOpen }"
      @click.stop="toggleMenu"
    >
      <span>{{ t('library.moveSong') }}</span>
      <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <path d="M2.25 4.5 6 8.25 9.75 4.5" fill="none" stroke="currentColor" stroke-width="1.5" />
      </svg>
    </button>

    <transition name="fade">
      <div v-if="menuOpen" class="deck-move-button__menu">
        <button
          type="button"
          class="deck-move-button__menu-item"
          @click.stop="handleSelectTarget('FilterLibrary')"
        >
          {{ moveToFilterLabel }}
        </button>
        <button
          type="button"
          class="deck-move-button__menu-item"
          @click.stop="handleSelectTarget('CuratedLibrary')"
        >
          {{ moveToCuratedLabel }}
        </button>
        <button
          type="button"
          class="deck-move-button__menu-item"
          @click.stop="handleSelectTarget('MixtapeLibrary')"
        >
          {{ addToMixtapeLabel }}
        </button>
      </div>
    </transition>
  </div>
</template>

<style scoped lang="scss">
.deck-move-button {
  position: relative;
  flex: 0 0 auto;
  margin-left: auto;
}

.deck-move-button__trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  min-width: 84px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 12px;
  line-height: 22px;
  white-space: nowrap;
  box-sizing: border-box;
  cursor: pointer;
  transition:
    border-color 0.14s ease,
    background-color 0.14s ease,
    color 0.14s ease,
    box-shadow 0.14s ease;
}

.deck-move-button__trigger:hover:not(:disabled),
.deck-move-button__trigger.is-open {
  border-color: var(--accent);
  background: var(--hover);
}

.deck-move-button__trigger:disabled {
  opacity: 0.52;
  cursor: not-allowed;
}

.deck-move-button__trigger svg {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
}

.deck-move-button__menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 180px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.26);
  z-index: 10045;
}

.deck-move-button__menu-item {
  width: 100%;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-size: 12px;
  line-height: 1.25;
  padding: 7px 9px;
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    border-color 0.14s ease,
    color 0.14s ease;
}

.deck-move-button__menu-item:hover {
  background: var(--hover);
  border-color: var(--divider);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.12s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
