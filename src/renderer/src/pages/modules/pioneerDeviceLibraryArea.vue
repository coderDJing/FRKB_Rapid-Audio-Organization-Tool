<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import pioneerDeviceLibraryItem from '@renderer/components/pioneerDeviceLibraryItem.vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import { t } from '@renderer/utils/translate'
import type { IPioneerPlaylistTreeNode } from '../../../../types/globals'

const runtime = useRuntimeStore()
const collapseButtonRef = useTemplateRef<HTMLDivElement>('collapseButtonRef')
const playlistSearch = ref('')
const expandedFolderIds = ref<Set<number>>(new Set())
const isDesktopSource = computed(
  () => runtime.pioneerDeviceLibrary.selectedSourceKind === 'desktop'
)

const title = computed(() => {
  if (runtime.pioneerDeviceLibrary.selectedSourceName) {
    return runtime.pioneerDeviceLibrary.selectedSourceName
  }
  return isDesktopSource.value ? 'Rekordbox 本机库' : 'Pioneer USB'
})
const originalTreeNodes = computed(() => runtime.pioneerDeviceLibrary.treeNodes || [])

const collectAllFolderIds = (nodes: IPioneerPlaylistTreeNode[]): number[] => {
  const ids: number[] = []
  const walk = (items: IPioneerPlaylistTreeNode[]) => {
    for (const item of items) {
      if (item.isFolder) ids.push(item.id)
      if (Array.isArray(item.children) && item.children.length > 0) {
        walk(item.children)
      }
    }
  }
  walk(nodes)
  return ids
}

const ensureExpandedFromTree = (nodes: IPioneerPlaylistTreeNode[]) => {
  expandedFolderIds.value = new Set()
}

const filterTreeByPlaylistName = (
  nodes: IPioneerPlaylistTreeNode[],
  keyword: string
): IPioneerPlaylistTreeNode[] => {
  const normalizedKeyword = keyword.trim().toLowerCase()
  if (!normalizedKeyword) return nodes

  const walk = (items: IPioneerPlaylistTreeNode[]): IPioneerPlaylistTreeNode[] => {
    const result: IPioneerPlaylistTreeNode[] = []
    for (const item of items) {
      const children = Array.isArray(item.children) ? walk(item.children) : []
      if (item.isFolder) {
        if (children.length > 0) {
          result.push({
            ...item,
            children
          })
        }
        continue
      }
      if (item.name.toLowerCase().includes(normalizedKeyword)) {
        result.push({
          ...item,
          children: []
        })
      }
    }
    return result
  }

  return walk(nodes)
}

const visibleTreeNodes = computed(() =>
  filterTreeByPlaylistName(originalTreeNodes.value, String(playlistSearch.value || ''))
)

const showHint = computed(
  () =>
    !runtime.pioneerDeviceLibrary.loading &&
    !visibleTreeNodes.value.length &&
    !String(playlistSearch.value || '').trim()
)

const statusText = computed(() => {
  if (runtime.pioneerDeviceLibrary.loading) {
    return isDesktopSource.value
      ? t('rekordboxDesktop.loadingPlaylistTree')
      : t('pioneer.loadingPlaylistTree')
  }
  if (String(playlistSearch.value || '').trim() && !visibleTreeNodes.value.length) {
    return t('pioneer.noMatchingPlaylists')
  }
  return isDesktopSource.value
    ? t('rekordboxDesktop.emptyPlaylistTree')
    : t('pioneer.emptyPlaylistTree')
})

const toggleFolder = (node: IPioneerPlaylistTreeNode) => {
  if (!node.isFolder) return
  const next = new Set(expandedFolderIds.value)
  if (next.has(node.id)) next.delete(node.id)
  else next.add(node.id)
  expandedFolderIds.value = next
}

const selectPlaylist = (node: IPioneerPlaylistTreeNode) => {
  if (node.isFolder) return
  runtime.pioneerDeviceLibrary.selectedPlaylistId =
    runtime.pioneerDeviceLibrary.selectedPlaylistId === node.id ? 0 : node.id
}

const collapseAllHandleClick = async () => {
  expandedFolderIds.value = new Set()
  await nextTick()
}

const lastTreeSignature = ref('')
const buildTreeSignature = (nodes: IPioneerPlaylistTreeNode[]) =>
  nodes.map((node) => `${node.id}:${node.order}:${node.children?.length || 0}`).join('|')

const hasPlaylistInTree = (nodes: IPioneerPlaylistTreeNode[], playlistId: number): boolean => {
  if (!playlistId) return false
  const walk = (items: IPioneerPlaylistTreeNode[]): boolean => {
    for (const item of items) {
      if (!item.isFolder && item.id === playlistId) return true
      if (Array.isArray(item.children) && item.children.length > 0 && walk(item.children)) {
        return true
      }
    }
    return false
  }
  return walk(nodes)
}

const syncExpandedWhenTreeChanges = () => {
  const signature = buildTreeSignature(originalTreeNodes.value)
  if (signature === lastTreeSignature.value) return
  lastTreeSignature.value = signature
  ensureExpandedFromTree(originalTreeNodes.value)
  const currentSelectedPlaylistId = Number(runtime.pioneerDeviceLibrary.selectedPlaylistId) || 0
  if (
    currentSelectedPlaylistId > 0 &&
    hasPlaylistInTree(originalTreeNodes.value, currentSelectedPlaylistId)
  ) {
    return
  }
  runtime.pioneerDeviceLibrary.selectedPlaylistId = 0
}

watch(
  originalTreeNodes,
  () => {
    syncExpandedWhenTreeChanges()
  },
  { immediate: true, deep: false }
)
</script>

<template>
  <div class="content">
    <div class="unselectable libraryTitle">
      <span class="libraryTitleText">{{ title }}</span>
      <div style="display: flex; justify-content: center; align-items: center">
        <div ref="collapseButtonRef" class="collapseButton" @click="collapseAllHandleClick()">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            xmlns="http://www.w3.org/2000/svg"
            fill="currentColor"
          >
            <path d="M9 9H4v1h5V9z" />
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"
            />
          </svg>
        </div>
        <bubbleBox :dom="collapseButtonRef || undefined" :title="t('playlist.collapsibleFolder')" />
      </div>
    </div>

    <div class="librarySearchWrapper">
      <div class="searchRow">
        <div class="searchInputWrapper">
          <input
            v-model="playlistSearch"
            class="searchInput"
            :placeholder="t('playlist.searchPlaylists')"
          />
          <div
            v-show="String(playlistSearch || '').length"
            class="clearBtn"
            @click="playlistSearch = ''"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              shape-rendering="geometricPrecision"
            >
              <path
                d="M3 3 L9 9 M9 3 L3 9"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                vector-effect="non-scaling-stroke"
              />
            </svg>
          </div>
        </div>
      </div>
    </div>

    <div class="unselectable libraryArea">
      <OverlayScrollbarsComponent
        :options="{
          scrollbars: {
            autoHide: 'leave' as const,
            autoHideDelay: 50,
            clickScroll: true
          } as const,
          overflow: {
            x: 'hidden',
            y: 'scroll'
          } as const
        }"
        element="div"
        style="height: 100%; width: 100%"
        defer
      >
        <template v-for="item of visibleTreeNodes" :key="`${item.id}:${item.order}`">
          <pioneerDeviceLibraryItem
            :node="item"
            :depth="0"
            :expanded-ids="expandedFolderIds"
            :filter-text="playlistSearch"
            @toggle-folder="toggleFolder"
            @select-playlist="selectPlaylist"
          />
        </template>

        <div
          style="
            flex-grow: 1;
            min-height: 30px;
            display: flex;
            justify-content: center;
            align-items: center;
          "
        >
          <span
            v-show="
              (showHint ||
                (playlistSearch && !visibleTreeNodes.length) ||
                runtime.pioneerDeviceLibrary.loading) &&
              runtime.layoutConfig.libraryAreaWidth !== 0
            "
            style="font-size: 12px; color: var(--text-weak); position: absolute; bottom: 50vh"
          >
            {{ statusText }}
          </span>
        </div>
      </OverlayScrollbarsComponent>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.libraryArea {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
}

.content {
  height: 100%;
  width: 100%;
  display: flex;
  flex-grow: 1;
  min-height: 0;
  background-color: var(--bg);
  overflow: hidden;
  flex-direction: column;

  .libraryTitle {
    height: 35px;
    line-height: 35px;
    padding: 0 18px 0 20px;
    font-size: 12px;
    font-weight: bold;
    display: flex;
    justify-content: space-between;
  }

  .libraryTitleText {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .collapseButton {
    color: var(--text);
    width: 20px;
    height: 20px;
    display: flex;
    justify-content: center;
    align-items: center;
    border-radius: 5px;

    &:hover {
      background-color: var(--hover);
    }
  }
}

.librarySearchWrapper {
  flex-shrink: 0;
  padding: 6px 5px 6px 5px;
  background-color: var(--bg);
}

.searchInput {
  width: 100%;
  height: 22px;
  line-height: 22px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  border-radius: 2px;
  padding: 0 8px;
  box-sizing: border-box;
  font-size: 12px;
  font-weight: normal;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.searchInputWrapper:hover .searchInput {
  background-color: var(--hover);
  border-color: var(--accent);
}

.searchRow {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
}

.searchRow .searchInput {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}

.searchInputWrapper {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}

.searchInputWrapper .searchInput {
  width: 100%;
  padding-right: 24px;
}

.clearBtn {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  display: flex;
  justify-content: center;
  align-items: center;
  border-radius: 50%;
  color: var(--text-weak);
  cursor: pointer;

  &:hover {
    color: var(--text);
    background-color: var(--hover);
  }
}
</style>
