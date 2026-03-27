<script setup lang="ts">
import { computed } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import listIconAsset from '@renderer/assets/listIcon.svg?asset'
import type { IPioneerPlaylistTreeNode } from '../../../types/globals'

const listIconMaskStyle = {
  '--icon-mask': `url("${listIconAsset}")`
}

const runtime = useRuntimeStore()

const props = defineProps({
  node: {
    type: Object as () => IPioneerPlaylistTreeNode,
    required: true
  },
  depth: {
    type: Number,
    default: 0
  },
  expandedIds: {
    type: Object as () => Set<number>,
    required: true
  },
  filterText: {
    type: String,
    default: ''
  }
})

const emit = defineEmits<{
  toggleFolder: [node: IPioneerPlaylistTreeNode]
  selectPlaylist: [node: IPioneerPlaylistTreeNode]
}>()

const hasChildren = computed(
  () => Array.isArray(props.node.children) && props.node.children.length > 0
)
const isExpanded = computed(() =>
  props.node.isFolder ? props.expandedIds.has(props.node.id) : false
)
const paddingLeft = computed(() => `${Math.max(0, props.depth) * 10}px`)
const isSelected = computed(
  () => !props.node.isFolder && runtime.pioneerDeviceLibrary.selectedPlaylistId === props.node.id
)

const handleClick = () => {
  if (props.node.isFolder) {
    emit('toggleFolder', props.node)
    return
  }
  emit('selectPlaylist', props.node)
}
</script>

<template>
  <div class="pioneer-tree-item">
    <div
      class="mainBody"
      style="display: flex; box-sizing: border-box"
      :style="{ paddingLeft }"
      :class="{ selectedDir: isSelected }"
      @click.stop="handleClick"
    >
      <div class="prefixIcon">
        <svg
          v-if="node.isFolder && !isExpanded"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          xmlns="http://www.w3.org/2000/svg"
          fill="currentColor"
        >
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z"
          />
        </svg>
        <svg
          v-else-if="node.isFolder"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          xmlns="http://www.w3.org/2000/svg"
          fill="currentColor"
        >
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"
          />
        </svg>
        <span v-else class="library-list-icon" :style="listIconMaskStyle"></span>
      </div>
      <div style="height: 23px; width: calc(100% - 20px)">
        <div class="nameRow">
          <span class="nameText">{{ node.name }}</span>
        </div>
      </div>
    </div>

    <div
      v-if="node.isFolder && isExpanded && hasChildren"
      style="width: 100%; box-sizing: border-box"
    >
      <template v-for="child of node.children" :key="`${child.id}:${child.order}`">
        <pioneerDeviceLibraryItem
          :node="child"
          :depth="depth + 1"
          :expanded-ids="expandedIds"
          :filter-text="filterText"
          @toggle-folder="emit('toggleFolder', $event)"
          @select-playlist="emit('selectPlaylist', $event)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
.library-list-icon {
  width: 13px;
  height: 13px;
  display: inline-block;
  background-color: currentColor;
  color: var(--text);
  mask-image: var(--icon-mask);
  mask-repeat: no-repeat;
  mask-position: center;
  mask-size: contain;
  -webkit-mask-image: var(--icon-mask);
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  -webkit-mask-size: contain;
}

.nameRow {
  line-height: 23px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 8px;
  position: relative;
}

.nameText {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selectedDir {
  background-color: var(--hover);

  &:hover {
    background-color: var(--hover) !important;
  }
}

.mainBody {
  &:hover {
    background-color: var(--hover);
  }
}

.prefixIcon {
  color: var(--text);
  width: 20px;
  min-width: 20px;
  height: 23px;
  display: flex;
  justify-content: center;
  align-items: center;
}
</style>
