<script setup lang="ts">
import welcomeLogoAsset from '@renderer/assets/welcomeLogo.png?asset'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { computed, onMounted, onUnmounted, ref } from 'vue'

type ShortcutRow = {
  title: string
  keys?: string[]
  keyGroups?: Array<{
    label: string
    key: string
  }>
  hint?: string
  minWidth?: number
  keySeparator?: string
  useGlobalShortcut?: boolean
}

const runtime = useRuntimeStore()
const welcomeLogo = welcomeLogoAsset
const isHorizontalMode = computed(() => runtime.mainWindowBrowseMode === 'horizontal')
const welcomeContainerRef = ref<HTMLElement | null>(null)
const horizontalContainerHeight = ref(272)
const deckLabels = {
  deck1: t('shortcuts.horizontalDeck1'),
  deck2: t('shortcuts.horizontalDeck2')
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const roundPx = (value: number) => `${Math.round(value)}px`

const horizontalLayoutStyle = computed<Record<string, string>>(() => {
  if (!isHorizontalMode.value) {
    return {} as Record<string, string>
  }

  const minHeight = 272
  const maxHeight = 420
  const progress = clampNumber(
    (horizontalContainerHeight.value - minHeight) / (maxHeight - minHeight),
    0,
    1
  )

  return {
    '--horizontal-content-gap': roundPx(5 + progress * 5),
    '--horizontal-column-gap': roundPx(18 + progress * 6),
    '--horizontal-row-gap': roundPx(1 + progress * 2),
    '--horizontal-row-min-height': roundPx(23 + progress * 3),
    '--horizontal-keybinding-min-height': roundPx(19 + progress * 3)
  }
})

const globalShortcut = computed(() => {
  const raw = String(runtime.setting.globalCallShortcut || '').trim()
  if (!raw) {
    return []
  }
  return raw.split('+').map((key) => ({
    key,
    needSeparator: true
  }))
})

const browserShortcutRows = computed<ShortcutRow[]>(() => [
  {
    title: t('player.playPause'),
    keys: ['Space']
  },
  {
    title: t('player.previousNext'),
    keys: ['W / S'],
    hint: '( ↑ / ↓ )'
  },
  {
    title: t('player.fastBackwardForward'),
    keys: ['A / D'],
    hint: '( ← / → )'
  },
  {
    title: t('player.seekPercent'),
    keys: [t('player.seekPercentKeys')],
    hint: t('player.seekPercentHint')
  },
  {
    title: t('shortcuts.globalPreviousNext'),
    keys: ['Shift', 'Alt', 'Up / Down']
  },
  {
    title: t('shortcuts.globalFastBackwardForward'),
    keys: ['Shift', 'Alt', 'Left / Right']
  },
  {
    title: t('player.moveToLibraries'),
    keys: ['Q / E']
  },
  {
    title: t('common.delete'),
    keys: ['F'],
    hint: '( Delete )'
  },
  {
    title: t('player.playbackRange'),
    keys: ['R']
  },
  {
    title: t('player.volumeControl'),
    keys: ['+ / -']
  },
  {
    title: t('player.showHide'),
    minWidth: 250,
    useGlobalShortcut: true
  }
])

const horizontalShortcutRows = computed<ShortcutRow[]>(() => [
  {
    title: t('shortcuts.horizontalLoadDeck'),
    keyGroups: [
      { label: deckLabels.deck1, key: t('shortcuts.horizontalLoadDeck1Key') },
      { label: deckLabels.deck2, key: t('shortcuts.horizontalLoadDeck2Key') }
    ],
    keySeparator: ' / '
  },
  {
    title: t('shortcuts.horizontalPlayPause'),
    keyGroups: [
      { label: deckLabels.deck1, key: 'Space' },
      { label: deckLabels.deck2, key: 'Shift+Space' }
    ],
    keySeparator: ' / '
  },
  {
    title: t('shortcuts.horizontalCue'),
    keyGroups: [
      { label: deckLabels.deck1, key: 'C' },
      { label: deckLabels.deck2, key: 'Shift+C' }
    ],
    keySeparator: ' / '
  },
  {
    title: t('shortcuts.horizontalBarJump'),
    keyGroups: [
      { label: deckLabels.deck1, key: 'A / D' },
      { label: deckLabels.deck2, key: 'Shift+A / Shift+D' }
    ],
    hint: '( ← / → ) / ( Shift+← / Shift+→ )',
    keySeparator: ' / '
  },
  {
    title: t('shortcuts.horizontalCrossfaderMove'),
    keys: ['W / S', '↑ / ↓'],
    keySeparator: ' / '
  },
  {
    title: t('shortcuts.horizontalCrossfaderReset'),
    keys: ['Shift+W / Shift+S', 'Shift+↑ / Shift+↓'],
    keySeparator: ' / '
  },
  {
    title: t('shortcuts.horizontalMoveToFilter'),
    keyGroups: [
      { label: deckLabels.deck1, key: 'Q' },
      { label: deckLabels.deck2, key: 'Shift+Q' }
    ],
    keySeparator: ' / '
  },
  {
    title: t('shortcuts.horizontalMoveToCurated'),
    keyGroups: [
      { label: deckLabels.deck1, key: 'E' },
      { label: deckLabels.deck2, key: 'Shift+E' }
    ],
    keySeparator: ' / '
  },
  {
    title: t('shortcuts.horizontalDeleteTracks'),
    keyGroups: [
      { label: deckLabels.deck1, key: 'F' },
      { label: deckLabels.deck2, key: 'Shift+F' }
    ],
    keySeparator: ' / '
  },
  {
    title: t('shortcuts.horizontalSeekPercent'),
    keyGroups: [
      {
        label: deckLabels.deck1,
        key: t('shortcuts.horizontalSeekPercentPrimaryKeys')
      },
      {
        label: deckLabels.deck2,
        key: t('shortcuts.horizontalSeekPercentSecondaryKeys')
      }
    ],
    hint: t('player.seekPercentHint'),
    keySeparator: ' / '
  },
  {
    title: t('player.showHide'),
    minWidth: 250,
    useGlobalShortcut: true
  }
])

const horizontalShortcutColumns = computed<ShortcutRow[][]>(() => {
  const rows = horizontalShortcutRows.value
  const columnCount = 2
  const columnSize = Math.ceil(rows.length / columnCount)

  return Array.from({ length: columnCount }, (_, index) =>
    rows.slice(index * columnSize, (index + 1) * columnSize)
  ).filter((column) => column.length > 0)
})

const shortcutRows = computed(() =>
  runtime.mainWindowBrowseMode === 'horizontal'
    ? horizontalShortcutRows.value
    : browserShortcutRows.value
)

let resizeObserver: ResizeObserver | null = null

const syncHorizontalContainerHeight = () => {
  horizontalContainerHeight.value = welcomeContainerRef.value?.clientHeight || 272
}

onMounted(() => {
  syncHorizontalContainerHeight()
  if (typeof ResizeObserver === 'undefined' || !welcomeContainerRef.value) return
  resizeObserver = new ResizeObserver(() => {
    syncHorizontalContainerHeight()
  })
  resizeObserver.observe(welcomeContainerRef.value)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <div
    ref="welcomeContainerRef"
    class="welcome-container"
    :class="{ 'welcome-container--horizontal': isHorizontalMode }"
    :style="horizontalLayoutStyle"
  >
    <div class="welcome-content" :class="{ 'welcome-content--horizontal': isHorizontalMode }">
      <img
        :src="welcomeLogo"
        width="150"
        height="150"
        alt=""
        class="unselectable welcome-logo theme-icon"
        :class="{ 'welcome-logo--horizontal': isHorizontalMode }"
        draggable="false"
      />
      <div v-if="isHorizontalMode" class="shortcuts shortcuts--horizontal">
        <div
          v-for="(column, columnIndex) in horizontalShortcutColumns"
          :key="`shortcut-column-${columnIndex}`"
          class="shortcut-column"
        >
          <dl v-for="row in column" :key="row.title" class="shortcut-row--horizontal">
            <dt>{{ row.title }}</dt>
            <dd>
              <div class="monaco-keybinding">
                <template v-if="row.useGlobalShortcut">
                  <template v-for="(item, index) in globalShortcut" :key="`${row.title}-${index}`">
                    <span class="monaco-keybinding-key">{{ item.key }}</span>
                    <span
                      v-if="index !== globalShortcut.length - 1"
                      class="monaco-keybinding-key-separator"
                      >+</span
                    >
                  </template>
                </template>
                <template v-else-if="row.keyGroups">
                  <template
                    v-for="(item, index) in row.keyGroups"
                    :key="`${row.title}-${item.label}-${item.key}-${index}`"
                  >
                    <span class="shortcut-key-group">
                      <span class="shortcut-key-group-label">{{ item.label }}</span>
                      <span class="monaco-keybinding-key">{{ item.key }}</span>
                    </span>
                    <span
                      v-if="index !== row.keyGroups.length - 1"
                      class="monaco-keybinding-key-separator"
                      >{{ row.keySeparator || '+' }}</span
                    >
                  </template>
                </template>
                <template v-else>
                  <template v-for="(key, index) in row.keys" :key="`${row.title}-${key}-${index}`">
                    <span class="monaco-keybinding-key">{{ key }}</span>
                    <span
                      v-if="index !== (row.keys?.length || 0) - 1"
                      class="monaco-keybinding-key-separator"
                      >{{ row.keySeparator || '+' }}</span
                    >
                  </template>
                </template>
                <span v-if="row.hint" class="easter-egg">{{ row.hint }}</span>
              </div>
            </dd>
          </dl>
        </div>
      </div>
      <div v-else class="shortcuts">
        <dl v-for="row in shortcutRows" :key="row.title">
          <dt>{{ row.title }}</dt>
          <dd>
            <div
              class="monaco-keybinding"
              :style="row.minWidth ? { minWidth: `${row.minWidth}px` } : {}"
            >
              <template v-if="row.useGlobalShortcut">
                <template v-for="(item, index) in globalShortcut" :key="`${row.title}-${index}`">
                  <span class="monaco-keybinding-key">{{ item.key }}</span>
                  <span
                    v-if="index !== globalShortcut.length - 1"
                    class="monaco-keybinding-key-separator"
                    >+</span
                  >
                </template>
              </template>
              <template v-else>
                <template v-for="(key, index) in row.keys" :key="`${row.title}-${key}-${index}`">
                  <span class="monaco-keybinding-key">{{ key }}</span>
                  <span
                    v-if="index !== (row.keys?.length || 0) - 1"
                    class="monaco-keybinding-key-separator"
                    >{{ row.keySeparator || '+' }}</span
                  >
                </template>
              </template>
              <span v-if="row.hint" class="easter-egg">{{ row.hint }}</span>
            </div>
          </dd>
        </dl>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.welcome-container {
  width: 100%;
  height: 100%;
  padding: 20px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.welcome-container--horizontal {
  padding: 12px 16px;
  align-items: center;
  justify-content: center;
  --horizontal-content-gap: 5px;
  --horizontal-column-gap: 18px;
  --horizontal-row-gap: 1px;
  --horizontal-row-min-height: 23px;
  --horizontal-keybinding-min-height: 19px;
}

.welcome-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  color: var(--text-weak);
  width: min(100%, 430px);
  max-width: 430px;
  flex-shrink: 0;
  min-width: 0;
  gap: 12px;
}

.welcome-content--horizontal {
  width: min(100%, 820px);
  max-width: 820px;
  align-items: stretch;
  justify-content: center;
  gap: var(--horizontal-content-gap);
}

.welcome-logo {
  width: 150px;
  height: 150px;
  flex-shrink: 0;
}

.welcome-logo--horizontal {
  width: 72px;
  height: 72px;
  align-self: center;
}

.shortcuts {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-width: 0;
}

.shortcuts--horizontal {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  justify-content: center;
  gap: var(--horizontal-column-gap);
}

.shortcut-column {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: var(--horizontal-row-gap);
  min-width: 0;
}

dl {
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  align-items: center;
  min-width: 0;

  &:last-child {
    margin-bottom: 0;
  }
}

.shortcut-row--horizontal {
  margin: 0;
  min-height: var(--horizontal-row-min-height);
}

dt {
  font-size: 14px;
  text-align: right;
  width: 220px;
  padding-right: 10px;
  flex-shrink: 0;
  box-sizing: border-box;
  white-space: normal;
  line-height: 1.4;
}

.shortcut-row--horizontal dt {
  width: clamp(132px, 38%, 168px);
  min-width: 132px;
  padding-right: 8px;
  text-align: right;
  font-size: 12px;
  line-height: 1.35;
  white-space: nowrap;
}

dd {
  margin: 0;
  text-align: left;
  width: auto;
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
}

.shortcut-row--horizontal dd {
  width: auto;
}

.monaco-keybinding {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  position: relative;
  min-width: 0;

  .easter-egg {
    margin-left: 8px;
    color: var(--text);
    font-size: 11px;
    opacity: 0;
    transition: opacity 0.3s ease;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  &:hover {
    .easter-egg {
      opacity: 1;
    }
  }
}

.monaco-keybinding-key {
  padding: 4px 8px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-bottom-color: var(--border);
  box-shadow: inset 0 -1px 0 var(--border);
  border-radius: 3px;
  font-size: 11px;
  min-width: 0;
  max-width: 100%;
  display: inline-flex;
  justify-content: center;
  text-align: center;
  color: var(--text-weak);
  white-space: normal;
  overflow-wrap: anywhere;
}

.monaco-keybinding-key-separator {
  padding: 0 4px;
  color: var(--text-weak);
}

.shortcut-key-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.shortcut-key-group-label {
  color: var(--text-weak);
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
}

.shortcuts--horizontal .monaco-keybinding {
  align-items: center;
  min-height: var(--horizontal-keybinding-min-height);
}

.shortcuts--horizontal .monaco-keybinding-key {
  padding: 3px 6px;
  font-size: 10px;
  line-height: 1.25;
}

.shortcuts--horizontal .monaco-keybinding-key-separator {
  padding: 0 3px;
}

.shortcuts--horizontal .shortcut-key-group {
  gap: 3px;
}

.shortcuts--horizontal .shortcut-key-group-label {
  font-size: 9px;
}

.shortcuts--horizontal .easter-egg {
  display: none;
}

.global-shortcut-divider {
  color: var(--text-weak);
  font-size: 13px;
}

.unselectable {
  user-select: none;
  -webkit-user-drag: none;
}
</style>
