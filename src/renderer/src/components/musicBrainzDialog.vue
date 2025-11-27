<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { t } from '@renderer/utils/translate'
import hotkeys from 'hotkeys-js'
import utils from '@renderer/utils/utils'
import { v4 as uuidV4 } from 'uuid'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import type {
  IMusicBrainzMatch,
  IMusicBrainzSuggestionResult,
  IMusicBrainzSearchPayload,
  IMusicBrainzApplyPayload
} from 'src/types/globals'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'

const uuid = uuidV4()

const props = defineProps({
  filePath: {
    type: String,
    required: true
  },
  initialQuery: {
    type: Object as () =>
      | {
          title?: string
          artist?: string
          album?: string
          durationSeconds?: number
          isrc?: string
        }
      | undefined,
    default: () => ({})
  },
  confirmCallback: {
    type: Function,
    required: true
  },
  cancelCallback: {
    type: Function,
    required: true
  }
})

const query = reactive({
  title: props.initialQuery?.title || '',
  artist: props.initialQuery?.artist || '',
  album: props.initialQuery?.album || ''
})
const durationSeconds = ref<number | undefined>(props.initialQuery?.durationSeconds)
const localIsrc = computed(() => normalizeIsrcValue(props.initialQuery?.isrc))

const state = reactive({
  searching: false,
  searchError: '',
  results: [] as IMusicBrainzMatch[],
  suggestion: null as IMusicBrainzSuggestionResult | null,
  suggestionError: '',
  suggestionLoading: false,
  selectedRecordingId: '',
  hasSearched: false
})

const FIELD_KEYS = [
  'title',
  'artist',
  'album',
  'albumArtist',
  'year',
  'genre',
  'label',
  'isrc',
  'trackNo',
  'trackTotal',
  'discNo',
  'discTotal'
] as const
type FieldKey = (typeof FIELD_KEYS)[number]
type FieldKeyWithCover = FieldKey | 'cover'
const fieldMeta: Array<{ key: FieldKeyWithCover; label: string }> = [
  { key: 'title', label: t('metadata.title') },
  { key: 'artist', label: t('metadata.artist') },
  { key: 'album', label: t('metadata.album') },
  { key: 'albumArtist', label: t('metadata.albumArtist') },
  { key: 'year', label: t('metadata.year') },
  { key: 'genre', label: t('metadata.genre') },
  { key: 'label', label: t('metadata.label') },
  { key: 'isrc', label: t('metadata.isrc') },
  { key: 'trackNo', label: t('metadata.trackNo') },
  { key: 'trackTotal', label: t('metadata.trackTotal') },
  { key: 'discNo', label: t('metadata.discNo') },
  { key: 'discTotal', label: t('metadata.discTotal') },
  { key: 'cover', label: t('metadata.cover') }
]

const fieldSelections = reactive<Record<FieldKeyWithCover, boolean>>({
  title: true,
  artist: true,
  album: true,
  albumArtist: true,
  year: true,
  genre: true,
  label: true,
  isrc: true,
  trackNo: true,
  trackTotal: true,
  discNo: true,
  discTotal: true,
  cover: true
})

const canConfirm = computed(() => !!state.suggestion && !state.suggestionLoading)
const suggestionCoverDataUrl = computed(() => state.suggestion?.suggestion.coverDataUrl)

function formatSeconds(seconds?: number) {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) return '--:--'
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function mapError(code?: string) {
  if (!code) return t('metadata.musicbrainzGenericError')
  switch (code) {
    case 'MUSICBRAINZ_RATE_LIMITED':
      return t('metadata.musicbrainzRateLimited')
    case 'MUSICBRAINZ_UNAVAILABLE':
      return t('metadata.musicbrainzUnavailable')
    case 'MUSICBRAINZ_TIMEOUT':
      return t('metadata.musicbrainzTimeout')
    case 'MUSICBRAINZ_NETWORK':
      return t('metadata.musicbrainzNetworkError')
    case 'MUSICBRAINZ_EMPTY_QUERY':
      return t('metadata.musicbrainzNeedKeyword')
    default:
      return t('metadata.musicbrainzGenericError')
  }
}

function describeMatchedFields(fields: string[]) {
  if (!Array.isArray(fields) || !fields.length) return ''
  const mapping: Record<string, string> = {
    title: t('metadata.title'),
    artist: t('metadata.artist'),
    album: t('metadata.album'),
    duration: t('columns.duration')
  }
  return fields.map((f) => mapping[f] || f).join(' / ')
}

function buildSearchPayload(): IMusicBrainzSearchPayload | null {
  const title = query.title.trim()
  const artist = query.artist.trim()
  const album = query.album.trim()
  const duration = durationSeconds.value
  if (!title && !artist && !album && !duration) return null
  return {
    filePath: props.filePath,
    title: title || undefined,
    artist: artist || undefined,
    album: album || undefined,
    durationSeconds: duration
  }
}

async function searchMusicBrainz() {
  if (state.searching) return
  const payload = buildSearchPayload()
  if (!payload) {
    state.searchError = t('metadata.musicbrainzNeedKeyword')
    return
  }
  state.searching = true
  state.searchError = ''
  state.results = []
  state.suggestion = null
  state.selectedRecordingId = ''
  try {
    const results = (await window.electron.ipcRenderer.invoke(
      'musicbrainz:search',
      payload
    )) as IMusicBrainzMatch[]
    state.results = results
    state.hasSearched = true
    if (!results.length) return
    selectMatch(results[0])
  } catch (err: any) {
    state.searchError = mapError(err?.message)
    state.hasSearched = true
  } finally {
    state.searching = false
  }
}

async function selectMatch(match: IMusicBrainzMatch) {
  state.selectedRecordingId = match.recordingId
  state.suggestionLoading = true
  state.suggestionError = ''
  state.suggestion = null
  try {
    const result = (await window.electron.ipcRenderer.invoke('musicbrainz:suggest', {
      recordingId: match.recordingId,
      releaseId: match.releaseId
    })) as IMusicBrainzSuggestionResult
    state.suggestion = result
    resetFieldSelections(result)
  } catch (err: any) {
    state.suggestionError = mapError(err?.message)
  } finally {
    state.suggestionLoading = false
  }
}

function resetFieldSelections(result: IMusicBrainzSuggestionResult | null) {
  Object.keys(fieldSelections).forEach((key) => {
    fieldSelections[key as FieldKeyWithCover] = false
  })
  if (!result) return
  FIELD_KEYS.forEach((key) => {
    const value = result.suggestion[key]
    fieldSelections[key] = value !== undefined && value !== null && value !== ''
  })
  fieldSelections.cover = result.suggestion.coverDataUrl !== undefined
}

function hasIsrcMatch(match: IMusicBrainzMatch) {
  const candidate = normalizeIsrcValue(match.isrc)
  if (!candidate) return false
  const local = localIsrc.value
  return !!local && local === candidate
}

function shouldShowDurationDiff(match: IMusicBrainzMatch) {
  return typeof match.durationDiffSeconds === 'number'
}

function durationDiffClass(diff?: number) {
  if (typeof diff !== 'number') return ''
  if (diff <= 2) return 'tag-good'
  if (diff > 6) return 'tag-warn'
  return ''
}

function durationDiffText(diff?: number) {
  if (typeof diff !== 'number') return ''
  return t('metadata.musicbrainzDurationDiff', { seconds: diff })
}

function hasMusicBrainzValue(key: FieldKeyWithCover) {
  const suggestion = state.suggestion?.suggestion
  if (!suggestion) return false
  if (key === 'cover') {
    return suggestion.coverDataUrl !== undefined
  }
  const value = suggestion[key as FieldKey]
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

function getFieldText(key: FieldKeyWithCover) {
  const suggestion = state.suggestion?.suggestion
  if (!suggestion) return '--'
  if (key === 'cover') {
    if (suggestion.coverDataUrl === undefined) return '--'
    return suggestion.coverDataUrl ? t('metadata.musicbrainzCoverReady') : t('metadata.noCover')
  }
  const value = suggestion[key as FieldKey]
  if (value === undefined || value === null) return '--'
  return typeof value === 'number' ? String(value) : value
}

function buildApplyPayload(): IMusicBrainzApplyPayload | null {
  const suggestion = state.suggestion?.suggestion
  if (!suggestion) return null
  const payload: IMusicBrainzApplyPayload = {}
  const setString = (key: keyof IMusicBrainzApplyPayload, value?: string | null) => {
    if (value === undefined || value === null || value === '') return
    ;(payload as any)[key] = value
  }
  const applyField = (key: FieldKey, getter: () => string | number | undefined | null) => {
    if (!fieldSelections[key]) return
    const value = getter()
    if (value === undefined || value === null) return
    if (typeof value === 'number') {
      ;(payload as any)[key] = value
    } else if (typeof value === 'string') {
      setString(key, value)
    }
  }
  applyField('title', () => suggestion.title)
  applyField('artist', () => suggestion.artist)
  applyField('album', () => suggestion.album)
  applyField('albumArtist', () => suggestion.albumArtist)
  applyField('year', () => suggestion.year)
  applyField('genre', () => suggestion.genre)
  applyField('label', () => suggestion.label)
  applyField('isrc', () => suggestion.isrc)
  applyField('trackNo', () => suggestion.trackNo ?? undefined)
  applyField('trackTotal', () => suggestion.trackTotal ?? undefined)
  applyField('discNo', () => suggestion.discNo ?? undefined)
  applyField('discTotal', () => suggestion.discTotal ?? undefined)
  if (fieldSelections.cover) {
    payload.coverDataUrl =
      suggestion.coverDataUrl === undefined ? undefined : suggestion.coverDataUrl || null
  }
  return payload
}

async function handleConfirm() {
  if (!canConfirm.value) return
  const payload = buildApplyPayload()
  if (!payload) return
  props.confirmCallback({ payload })
}

function handleCancel() {
  props.cancelCallback()
}

function autoSearch() {
  const hasInitial =
    (query.title && query.title.trim() !== '') ||
    (query.artist && query.artist.trim() !== '') ||
    (query.album && query.album.trim() !== '') ||
    typeof durationSeconds.value === 'number'
  if (hasInitial) {
    nextTick(() => searchMusicBrainz())
  }
}

function normalizeText(value?: string | null) {
  if (!value) return ''
  return value.trim()
}

function normalizeIsrcValue(value?: string | null) {
  if (!value) return ''
  const trimmed = value.trim()
  return trimmed === '' ? '' : trimmed.toUpperCase()
}

onMounted(() => {
  hotkeys('esc', uuid, (event) => {
    event.preventDefault()
    handleCancel()
  })
  hotkeys('enter', uuid, (event) => {
    if ((event.target as HTMLElement)?.tagName === 'TEXTAREA') return
    if ((event.target as HTMLElement)?.tagName === 'INPUT') return
    event.preventDefault()
    handleConfirm()
  })
  utils.setHotkeysScpoe(uuid)
  autoSearch()
})

onUnmounted(() => {
  hotkeys.unbind('esc', uuid)
  hotkeys.unbind('enter', uuid)
  utils.delHotkeysScope(uuid)
})
</script>

<template>
  <div class="dialog musicbrainz-dialog unselectable">
    <div class="inner" v-dialog-drag="'.dialog-title'">
      <div class="dialog-title">{{ t('metadata.musicbrainzDialogTitle') }}</div>
      <div class="body">
        <OverlayScrollbarsComponent
          :options="{
            scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
            overflow: { x: 'hidden', y: 'scroll' } as const
          }"
          element="div"
          style="height: 100%; width: 100%"
          defer
        >
          <div class="content">
            <div class="section">
              <div class="section-title">{{ t('metadata.musicbrainzQueryTitle') }}</div>
              <div class="musicbrainz-query-grid">
                <label>{{ t('metadata.title') }}</label>
                <input v-model="query.title" :disabled="state.searching" />
                <label>{{ t('metadata.artist') }}</label>
                <input v-model="query.artist" :disabled="state.searching" />
                <label>{{ t('metadata.album') }}</label>
                <input v-model="query.album" :disabled="state.searching" />
                <label>{{ t('columns.duration') }}</label>
                <div class="musicbrainz-duration">
                  {{ formatSeconds(durationSeconds) }}
                </div>
              </div>
              <div class="musicbrainz-panel-actions">
                <div
                  class="button"
                  :class="{ disabled: state.searching }"
                  @click="state.searching ? null : searchMusicBrainz()"
                >
                  {{
                    state.searching
                      ? t('metadata.musicbrainzSearching')
                      : t('metadata.musicbrainzSearch')
                  }}
                </div>
              </div>
              <div v-if="state.searchError" class="error-text">
                {{ state.searchError }}
              </div>
            </div>

            <div
              v-if="!state.searchError && state.hasSearched && state.results.length === 0"
              class="musicbrainz-empty"
            >
              {{ t('metadata.musicbrainzNoResult') }}
            </div>

            <div v-if="state.results.length" class="musicbrainz-results">
              <div
                v-for="match in state.results"
                :key="match.recordingId"
                class="musicbrainz-result"
                :class="{ active: match.recordingId === state.selectedRecordingId }"
                @click="selectMatch(match)"
              >
                <div class="result-title-row">
                  <div class="result-title">{{ match.title }}</div>
                  <div class="result-score">
                    {{ t('metadata.musicbrainzScore', { score: match.score }) }}
                  </div>
                </div>
                <div class="result-meta">
                  <span>{{ match.artist }}</span>
                  <span v-if="match.releaseTitle">{{ match.releaseTitle }}</span>
                  <span v-if="match.durationSeconds">
                    {{ formatSeconds(match.durationSeconds) }}
                  </span>
                </div>
                <div class="result-meta small" v-if="match.releaseDate">
                  {{ t('metadata.musicbrainzReleaseDate') }}: {{ match.releaseDate }}
                </div>
                <div class="result-meta small" v-if="match.matchedFields.length">
                  {{
                    t('metadata.musicbrainzMatchedFields', {
                      fields: describeMatchedFields(match.matchedFields)
                    })
                  }}
                </div>
                <div
                  class="result-tags"
                  v-if="shouldShowDurationDiff(match) || hasIsrcMatch(match)"
                >
                  <span
                    v-if="shouldShowDurationDiff(match)"
                    class="tag"
                    :class="durationDiffClass(match.durationDiffSeconds)"
                  >
                    {{ durationDiffText(match.durationDiffSeconds) }}
                  </span>
                  <span v-if="hasIsrcMatch(match)" class="tag tag-good">
                    {{ t('metadata.musicbrainzIsrcMatch') }}
                  </span>
                </div>
              </div>
            </div>

            <div class="musicbrainz-suggestion">
              <div v-if="state.suggestionLoading" class="musicbrainz-loading">
                {{ t('metadata.musicbrainzLoadingSuggestion') }}
              </div>
              <div v-else-if="state.suggestionError" class="error-text">
                {{ state.suggestionError }}
              </div>
              <div v-else-if="state.suggestion" class="musicbrainz-suggestion-body">
                <div class="musicbrainz-suggestion-meta">
                  <div>
                    {{ t('metadata.musicbrainzChosenRelease') }}：
                    {{ state.suggestion.releaseTitle || '--' }}
                  </div>
                  <div>
                    {{ t('metadata.musicbrainzReleaseDate') }}：
                    {{ state.suggestion.releaseDate || '--' }}
                  </div>
                  <div>
                    {{ t('metadata.musicbrainzLabel') }}：
                    {{ state.suggestion.label || '--' }}
                  </div>
                </div>
                <div class="musicbrainz-suggestion-content">
                  <div class="musicbrainz-cover-preview">
                    <img
                      v-if="suggestionCoverDataUrl"
                      :src="suggestionCoverDataUrl"
                      alt="cover"
                      draggable="false"
                    />
                    <div v-else class="cover-placeholder">
                      {{ t('metadata.noCover') }}
                    </div>
                  </div>
                  <div class="musicbrainz-field-grid">
                    <div
                      v-for="field in fieldMeta"
                      :key="field.key"
                      class="musicbrainz-field-row"
                      :class="{ disabled: !hasMusicBrainzValue(field.key) }"
                    >
                      <singleCheckbox v-model="fieldSelections[field.key]">
                        <div class="field-slot">
                          <span class="field-name">{{ field.label }}</span>
                          <span class="field-value">{{ getFieldText(field.key) }}</span>
                        </div>
                      </singleCheckbox>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </OverlayScrollbarsComponent>
      </div>

      <div class="footer">
        <div
          class="button"
          :class="{ disabled: !canConfirm }"
          @click="canConfirm ? handleConfirm() : null"
        >
          {{ t('metadata.musicbrainzApplySelection') }}
        </div>
        <div class="button" @click="handleCancel">
          {{ t('common.cancel') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.musicbrainz-dialog .inner {
  width: 720px;
  height: 560px;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.dialog-title {
  text-align: center;
  height: 32px;
  line-height: 32px;
  font-size: 14px;
  font-weight: bold;
  border-bottom: 1px solid var(--border);
  background-color: var(--bg);
}

.body {
  flex: 1;
  min-height: 0;
}

.content {
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-size: 14px;
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--border);
  background-color: var(--bg);
}

.section-title {
  font-weight: bold;
  margin-bottom: 8px;
}

.musicbrainz-query-grid {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 8px 12px;
  align-items: center;
}

.musicbrainz-query-grid input {
  width: 100%;
  box-sizing: border-box;
  min-height: 26px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background-color: var(--bg-elev);
  color: var(--text);
  font-size: 14px;
  outline: none;
}

.musicbrainz-query-grid input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
}

.musicbrainz-duration {
  font-size: 13px;
  color: var(--text-secondary, #888);
}

.musicbrainz-panel-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}

.musicbrainz-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 200px;
  overflow: auto;
}

.musicbrainz-result {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.musicbrainz-result.active {
  border-color: var(--accent);
  background-color: rgba(0, 120, 212, 0.1);
}

.result-title-row {
  display: flex;
  justify-content: space-between;
  font-weight: bold;
}

.result-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.result-meta.small {
  font-size: 11px;
}

.result-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.tag {
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  font-size: 11px;
  line-height: 1.3;
  background-color: var(--bg);
}

.tag-good {
  border-color: var(--accent);
  color: var(--accent);
}

.tag-warn {
  border-color: #be1100;
  color: #be1100;
}

.musicbrainz-suggestion-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.musicbrainz-suggestion-meta {
  font-size: 12px;
  color: var(--text-secondary, #888);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.musicbrainz-suggestion-content {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.musicbrainz-cover-preview {
  width: 160px;
  height: 160px;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--bg);
  flex-shrink: 0;
}

.musicbrainz-cover-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-placeholder {
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.musicbrainz-field-grid {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.musicbrainz-field-row {
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
}

.musicbrainz-field-row:last-child {
  border-bottom: none;
}

.musicbrainz-field-row.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.musicbrainz-field-grid :deep(.checkBoxContainer) {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
}

.musicbrainz-field-grid :deep(.text) {
  width: 100%;
}

.musicbrainz-field-grid :deep(.field-slot) {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.musicbrainz-field-grid :deep(.field-name) {
  width: 120px;
  font-size: 13px;
}

.musicbrainz-field-grid :deep(.field-value) {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.musicbrainz-empty,
.musicbrainz-loading {
  font-size: 13px;
  color: var(--text-secondary, #888);
}
</style>
