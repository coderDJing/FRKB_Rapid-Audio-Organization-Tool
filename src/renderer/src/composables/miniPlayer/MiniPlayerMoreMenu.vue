<script setup lang="ts">
import { computed } from 'vue'
import shortcutIconAsset from '@renderer/assets/shortcutIcon.svg?asset'
import { t } from '@renderer/utils/translate'
import type { MiniPlayerOverlayMenuAction } from '@shared/miniPlayerWindow'

const shortcutIcon = shortcutIconAsset
const props = defineProps<{
  isReadOnly: boolean
  canDeleteAllAbove?: boolean
}>()

const emit = defineEmits<{
  (event: 'action', action: MiniPlayerOverlayMenuAction): void
}>()

const exportTrackLabel = computed(() =>
  props.isReadOnly ? t('tracks.exportTracksCopyOnly') : t('tracks.exportTracks')
)
const mixtapeLabel = computed(() =>
  props.isReadOnly ? t('library.addToMixtapeByCopy') : t('library.addToMixtape')
)
</script>

<template>
  <div class="more-menu unselectable">
    <div class="more-menu__section">
      <div class="menuButton" @click="emit('action', 'export')">
        <span>{{ exportTrackLabel }}</span>
      </div>
    </div>
    <div class="more-menu__section">
      <div v-if="!isReadOnly" class="menuButton" @click="emit('action', 'moveToFilter')">
        <div>
          <span>{{ t('library.moveToFilter') }}</span>
        </div>
        <div class="shortcut"><img :src="shortcutIcon" draggable="false" /><span>Q</span></div>
      </div>
      <div v-if="!isReadOnly" class="menuButton" @click="emit('action', 'moveToCurated')">
        <div>
          <span>{{ t('library.moveToCurated') }}</span>
        </div>
        <div class="shortcut"><img :src="shortcutIcon" draggable="false" /><span>E</span></div>
      </div>
      <div class="menuButton" @click="emit('action', 'copyToFilter')">
        <div>
          <span>{{ t('library.copyToFilter') }}</span>
        </div>
        <div v-if="isReadOnly" class="shortcut">
          <img :src="shortcutIcon" draggable="false" /><span>Q</span>
        </div>
      </div>
      <div class="menuButton" @click="emit('action', 'copyToCurated')">
        <div>
          <span>{{ t('library.copyToCurated') }}</span>
        </div>
        <div v-if="isReadOnly" class="shortcut">
          <img :src="shortcutIcon" draggable="false" /><span>E</span>
        </div>
      </div>
      <div class="menuButton" @click="emit('action', 'addToSet')">
        <span>{{ t('library.addToSet') }}</span>
      </div>
      <div class="menuButton" @click="emit('action', 'addToMixtape')">
        <span>{{ mixtapeLabel }}</span>
      </div>
    </div>
    <div v-if="!isReadOnly" class="more-menu__section">
      <div class="menuButton" @click="emit('action', 'delete')">
        <div>
          <span>{{ t('tracks.deleteTracks') }} </span>
        </div>
        <div class="shortcut"><img :src="shortcutIcon" draggable="false" /><span>F</span></div>
      </div>
      <div v-if="canDeleteAllAbove" class="menuButton" @click="emit('action', 'deleteAllAbove')">
        <span>{{ t('tracks.deleteAllAbove') }}</span>
      </div>
    </div>
    <div class="more-menu__section more-menu__section--last">
      <div class="menuButton" @click="emit('action', 'showInExplorer')">
        <span>{{ t('tracks.showInFileExplorer') }}</span>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.more-menu {
  width: 280px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  font-size: 14px;
  color: var(--text);
  box-sizing: border-box;
}

.more-menu__section {
  padding: 5px;
  border-bottom: 1px solid var(--border);

  &--last {
    border-bottom: none;
  }
}

.menuButton {
  display: flex;
  justify-content: space-between;
  padding: 5px 20px;
  border-radius: 5px;

  &:hover {
    background-color: var(--accent);
    color: #ffffff;
  }
}

.shortcut {
  display: flex;
  align-items: center;
  justify-content: flex-end;

  img {
    margin-right: 5px;
  }

  span {
    display: inline-block;
    width: 1.5ch;
    text-align: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  }
}
</style>
