<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, type ComponentPublicInstance } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import utils from '@renderer/utils/utils'
import { t } from '@renderer/utils/translate'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import type { ICuratedArtistFavorite } from 'src/types/globals'

type ArtistDraftEntry = {
  id: string
  name: string
  count: number
}

const props = defineProps<{
  artists: ICuratedArtistFavorite[]
  confirmCallback: (artists: ICuratedArtistFavorite[]) => void
  cancelCallback: () => void
}>()

const uuid = uuidV4()
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const entries = ref<ArtistDraftEntry[]>(
  (props.artists || []).map((artist) => ({
    id: uuidV4(),
    name: String(artist?.name || ''),
    count: Math.max(1, Math.round(Number(artist?.count) || 1))
  }))
)
const errorText = ref('')
const invalidEntryIds = ref<string[]>([])
const inputRefMap = new Map<string, HTMLInputElement | null>()

const sanitizeArtistName = (value: unknown) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
const normalizeArtistName = (value: unknown) => sanitizeArtistName(value).toLocaleLowerCase()

const totalCountText = computed(() =>
  t('settings.curatedArtistTracking.managerCount', { count: entries.value.length })
)

const resolveInputElement = (el: Element | ComponentPublicInstance | null) => {
  if (el && typeof (el as ComponentPublicInstance).$el !== 'undefined') {
    return ((el as ComponentPublicInstance).$el || null) as HTMLInputElement | null
  }
  return el as HTMLInputElement | null
}

const setInputRef = (id: string, el: Element | ComponentPublicInstance | null) => {
  inputRefMap.set(id, resolveInputElement(el))
}

const focusEntryInput = (id: string) => {
  nextTick(() => {
    const input = inputRefMap.get(id)
    if (!input) return
    input.focus()
    input.select()
  })
}

const clearValidationState = () => {
  errorText.value = ''
  invalidEntryIds.value = []
}

const addEntry = (name = '', count = 1) => {
  const entry = {
    id: uuidV4(),
    name,
    count: Math.max(1, Math.round(Number(count) || 1))
  }
  entries.value.push(entry)
  clearValidationState()
  focusEntryInput(entry.id)
}

const removeEntry = (id: string) => {
  entries.value = entries.value.filter((entry) => entry.id !== id)
  clearValidationState()
}

const validateEntries = (): ICuratedArtistFavorite[] | null => {
  const invalidIds: string[] = []
  const normalizedMap = new Map<string, string>()
  const nextArtists: ICuratedArtistFavorite[] = []

  for (const entry of entries.value) {
    const name = sanitizeArtistName(entry.name)
    const normalized = normalizeArtistName(name)
    if (!normalized) {
      invalidIds.push(entry.id)
      continue
    }
    const duplicated = normalizedMap.get(normalized)
    if (duplicated) {
      invalidIds.push(entry.id)
      errorText.value = t('settings.curatedArtistTracking.managerDuplicate', { artist: name })
      continue
    }
    normalizedMap.set(normalized, entry.id)
    nextArtists.push({
      name,
      count: Math.max(1, Math.round(Number(entry.count) || 1))
    })
  }

  if (invalidIds.length > 0) {
    invalidEntryIds.value = invalidIds
    if (!errorText.value) {
      errorText.value = t('settings.curatedArtistTracking.managerNameRequired')
    }
    focusEntryInput(invalidIds[0])
    return null
  }

  clearValidationState()
  return nextArtists
}

const clickSave = () => {
  const nextArtists = validateEntries()
  if (!nextArtists) return
  closeWithAnimation(() => props.confirmCallback(nextArtists))
}

const clickCancel = () => {
  closeWithAnimation(() => props.cancelCallback())
}

onMounted(() => {
  hotkeys('Esc', uuid, () => {
    clickCancel()
    return false
  })
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  inputRefMap.clear()
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">
        {{ t('settings.curatedArtistTracking.managerTitle') }}
      </div>
      <div class="body">
        <div class="toolbar">
          <div>
            <div class="toolbar-title">
              {{ t('settings.curatedArtistTracking.managerDesc') }}
            </div>
            <div class="toolbar-subtitle">{{ totalCountText }}</div>
          </div>
          <div class="button toolbar-button" @click="addEntry()">
            {{ t('settings.curatedArtistTracking.managerAddButton') }}
          </div>
        </div>
        <div class="error-slot">
          <div class="error-text" :class="{ 'error-text--hidden': !errorText }">
            {{ errorText || t('settings.curatedArtistTracking.managerValidationPlaceholder') }}
          </div>
        </div>
        <div class="list-shell">
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
            <div v-if="entries.length === 0" class="empty-state">
              {{ t('settings.curatedArtistTracking.managerEmpty') }}
            </div>
            <div v-else class="artist-list">
              <div v-for="(entry, index) in entries" :key="entry.id" class="artist-row">
                <div class="artist-index">{{ index + 1 }}</div>
                <input
                  :ref="(el) => setInputRef(entry.id, el)"
                  v-model="entry.name"
                  class="artist-input"
                  :class="{ 'artist-input--invalid': invalidEntryIds.includes(entry.id) }"
                  :placeholder="t('settings.curatedArtistTracking.managerInputPlaceholder')"
                  @input="clearValidationState()"
                />
                <bubbleBoxTrigger
                  tag="div"
                  class="artist-count"
                  :title="
                    t('settings.curatedArtistTracking.managerAddedCountTitle', {
                      artist:
                        entry.name || t('settings.curatedArtistTracking.managerUnnamedArtist'),
                      count: entry.count
                    })
                  "
                >
                  {{
                    t('settings.curatedArtistTracking.managerAddedCount', { count: entry.count })
                  }}
                </bubbleBoxTrigger>
                <div class="dangerButton artist-delete" @click="removeEntry(entry.id)">
                  {{ t('common.delete') }}
                </div>
              </div>
            </div>
          </OverlayScrollbarsComponent>
        </div>
      </div>
      <div class="dialog-footer">
        <div class="button" style="width: 110px; text-align: center" @click="clickSave()">
          {{ t('common.save') }}
        </div>
        <div class="button" style="width: 110px; text-align: center" @click="clickCancel()">
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 700px;
  height: 540px;
  display: flex;
  flex-direction: column;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 18px 18px;
  gap: 12px;
}

.toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.toolbar-title {
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
}

.toolbar-subtitle {
  margin-top: 4px;
  color: var(--text-secondary);
  font-size: 12px;
}

.toolbar-button {
  flex: 0 0 auto;
  width: 116px;
  text-align: center;
}

.error-slot {
  min-height: 18px;
}

.error-text {
  color: #e81123;
  font-size: 12px;
  line-height: 18px;
}

.error-text--hidden {
  visibility: hidden;
}

.list-shell {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}

.artist-list {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.artist-row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 104px 88px;
  align-items: center;
  gap: 10px;
}

.artist-row > * {
  min-width: 0;
}

.artist-index {
  height: 30px;
  line-height: 30px;
  text-align: center;
  border-radius: 6px;
  background: var(--bg-elev);
  color: var(--text-secondary);
  font-size: 12px;
  border: 1px solid var(--border);
}

.artist-input {
  width: 100%;
  min-width: 0;
  height: 30px;
  line-height: 30px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  border-radius: 6px;
  padding: 0 10px;
  box-sizing: border-box;

  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
  }
}

.artist-input--invalid {
  border-color: #e81123;
  box-shadow: 0 0 0 2px rgba(232, 17, 35, 0.16);
}

.artist-count {
  height: 30px;
  line-height: 30px;
  border-radius: 6px;
  background: rgba(200, 162, 60, 0.12);
  border: 1px solid rgba(200, 162, 60, 0.3);
  color: #9d7306;
  text-align: center;
  font-size: 12px;
  font-weight: 700;
  padding: 0 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artist-delete {
  width: 100%;
  text-align: center;
  box-sizing: border-box;
  white-space: nowrap;
}

.empty-state {
  height: 100%;
  min-height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
  padding: 24px;
}

@media (max-width: 720px) {
  .inner {
    width: min(700px, 94vw);
    height: min(540px, 82vh);
  }

  .artist-row {
    grid-template-columns: 32px minmax(0, 1fr) 92px 80px;
  }
}
</style>
