<script setup lang="ts">
import { useTemplateRef } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import EmptyRecycleBinIcon from '@renderer/components/EmptyRecycleBinIcon.vue'
import { t } from '@renderer/utils/translate'

defineProps<{
  title: string
  showEmptyRecycleBinButton: boolean
}>()
const searchQuery = defineModel<string>('searchQuery', { required: true })
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'empty-recycle-bin'): void
}>()
const searchInput = useTemplateRef<HTMLInputElement>('searchInput')
const clearSearch = () => {
  searchQuery.value = ''
  searchInput.value?.focus()
}
</script>

<template>
  <div class="songs-pane-header">
    <div class="songs-pane-header__title">{{ title }}</div>
    <bubbleBoxTrigger
      v-if="showEmptyRecycleBinButton"
      tag="button"
      class="songs-pane-header__button"
      type="button"
      :title="t('recycleBin.emptyRecycleBin')"
      @click.stop="emit('empty-recycle-bin')"
    >
      <EmptyRecycleBinIcon />
    </bubbleBoxTrigger>
    <div class="songs-pane-header__search" @click.stop @keydown.stop>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r="4.25" />
        <path d="m10 10 3.5 3.5" />
      </svg>
      <input
        ref="searchInput"
        v-model="searchQuery"
        type="text"
        :placeholder="t('tracks.playlistSearchPlaceholder')"
        :aria-label="t('tracks.playlistSearchPlaceholder')"
        autocomplete="off"
        spellcheck="false"
        @keydown.esc.prevent="clearSearch"
      />
      <bubbleBoxTrigger
        v-if="searchQuery"
        tag="button"
        class="songs-pane-header__button songs-pane-header__clear"
        type="button"
        :title="t('tracks.clearPlaylistSearch')"
        :aria-label="t('tracks.clearPlaylistSearch')"
        @click.stop="clearSearch"
      >
        <span aria-hidden="true">×</span>
      </bubbleBoxTrigger>
    </div>
    <bubbleBoxTrigger
      tag="button"
      class="songs-pane-header__button"
      type="button"
      :title="t('common.close')"
      :aria-label="t('common.close')"
      @click.stop="emit('close')"
    >
      <span aria-hidden="true">×</span>
    </bubbleBoxTrigger>
  </div>
</template>

<style scoped lang="scss">
.songs-pane-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  min-width: 0;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 90%, var(--font-color) 10%);
  flex-shrink: 0;
}

.songs-pane-header__title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--font-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.songs-pane-header__button {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--font-color);
  cursor: pointer;
  flex-shrink: 0;

  &:hover {
    background: color-mix(in srgb, var(--main-color) 18%, transparent);
  }
}

.songs-pane-header__search {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 190px;
  max-width: 50%;
  min-width: 0;
  height: 25px;
  padding: 0 5px;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
  color: var(--font-color);

  &:focus-within {
    border-color: var(--accent);
  }

  > svg {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    opacity: 0.65;
  }

  input {
    width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
    user-select: text;
    -webkit-user-select: text;

    &::placeholder {
      color: var(--font-color);
      opacity: 0.55;
    }
  }
}

.songs-pane-header__clear {
  width: 18px;
  height: 18px;
  border-radius: 3px;
}
</style>
