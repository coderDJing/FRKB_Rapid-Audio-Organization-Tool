<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { t } from '@renderer/utils/translate'
import hotkeys from 'hotkeys-js'
import utils from '@renderer/utils/utils'
import { mapAcoustIdClientError } from '@renderer/utils/acoustid'
import { v4 as uuidV4 } from 'uuid'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import type {
  IMusicBrainzMatch,
  IMusicBrainzSuggestionResult,
  IMusicBrainzSearchPayload,
  IMusicBrainzApplyPayload
} from 'src/types/globals'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { useRuntimeStore } from '@renderer/stores/runtime'

const uuid = uuidV4()
const runtime = useRuntimeStore()
const flashArea = ref('')
const flashBorder = (flashAreaName: string) => {
  flashArea.value = flashAreaName
  let count = 0
  const interval = setInterval(() => {
    count++
    if (count >= 3) {
      clearInterval(interval)
      flashArea.value = ''
    }
  }, 500)
}

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
  album: ''
})
const durationSeconds = ref<number | undefined>(props.initialQuery?.durationSeconds)
const localIsrc = computed(() => normalizeIsrcValue(props.initialQuery?.isrc))

type TabKey = 'text' | 'fingerprint'

const state = reactive({
  searching: false,
  searchError: '',
  textResults: [] as IMusicBrainzMatch[],
  textHasSearched: false,
  fingerprintResults: [] as IMusicBrainzMatch[],
  fingerprintHasSearched: false,
  suggestionByTab: {
    text: null,
    fingerprint: null
  } as Record<TabKey, IMusicBrainzSuggestionResult | null>,
  suggestionErrorByTab: {
    text: '',
    fingerprint: ''
  } as Record<TabKey, string>,
  suggestionLoadingByTab: {
    text: false,
    fingerprint: false
  } as Record<TabKey, boolean>,
  selectedRecordingIdByTab: {
    text: '',
    fingerprint: ''
  } as Record<TabKey, string>,
  fingerprintMatching: false,
  fingerprintStatus: '',
  fingerprintError: ''
})
const activeTab = ref<TabKey>('text')
const showAcoustIdPanel = ref(false)
const acoustIdKeyInput = ref('')
const acoustIdKeyError = ref('')
const savingAcoustIdKey = ref(false)
const pendingFingerprintAfterKey = ref(false)
const hasAcoustIdKey = computed(() => {
  const key = runtime.setting?.acoustIdClientKey
  if (typeof key !== 'string') return false
  return key.trim() !== ''
})

watch(hasAcoustIdKey, (val) => {
  if (val) {
    showAcoustIdPanel.value = false
    acoustIdKeyInput.value = runtime.setting?.acoustIdClientKey || ''
    acoustIdKeyError.value = ''
  }
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
const FIELD_KEYS_WITH_COVER: FieldKeyWithCover[] = [...FIELD_KEYS, 'cover']

function createDefaultFieldSelections() {
  const defaults: Record<FieldKeyWithCover, boolean> = {} as Record<FieldKeyWithCover, boolean>
  FIELD_KEYS_WITH_COVER.forEach((key) => {
    defaults[key] = true
  })
  return defaults
}

const fieldSelections = reactive<Record<FieldKeyWithCover, boolean>>(createDefaultFieldSelections())
const fieldSelectionsCache = reactive<Record<TabKey, Record<FieldKeyWithCover, boolean>>>({
  text: createDefaultFieldSelections(),
  fingerprint: createDefaultFieldSelections()
})

const currentSelectedRecordingId = computed(() => state.selectedRecordingIdByTab[activeTab.value])
const currentSuggestion = computed(() => state.suggestionByTab[activeTab.value])
const currentSuggestionError = computed(() => state.suggestionErrorByTab[activeTab.value])
const currentSuggestionLoading = computed(() => state.suggestionLoadingByTab[activeTab.value])
const canConfirm = computed(() => !!currentSuggestion.value && !currentSuggestionLoading.value)
const suggestionCoverDataUrl = computed(() => currentSuggestion.value?.suggestion.coverDataUrl)
const displayedResults = computed(() =>
  activeTab.value === 'fingerprint' ? state.fingerprintResults : state.textResults
)
const isTextTab = computed(() => activeTab.value === 'text')
const currentErrorMessage = computed(() =>
  activeTab.value === 'text' ? state.searchError : state.fingerprintError
)
const shouldShowEmptyState = computed(() => {
  if (activeTab.value === 'text') {
    return (
      !state.searchError &&
      state.textHasSearched &&
      !state.searching &&
      state.textResults.length === 0
    )
  }
  return (
    !state.fingerprintError &&
    state.fingerprintHasSearched &&
    !state.fingerprintMatching &&
    state.fingerprintResults.length === 0
  )
})
const hasQueryTextInput = computed(() => {
  return query.title.trim() !== '' || query.artist.trim() !== '' || query.album.trim() !== ''
})
const fingerprintStatusText = computed(() => {
  if (!state.fingerprintMatching) return ''
  return state.fingerprintStatus === 'lookup'
    ? t('metadata.musicbrainzFingerprintStatusLookup')
    : t('metadata.musicbrainzFingerprintStatusAnalyzing')
})

function formatSeconds(seconds?: number) {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) return '--:--'
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function mapError(code?: string) {
  if (!code) return t('metadata.musicbrainzGenericError')
  const normalized = String(code || '').split(':')[0]
  switch (normalized) {
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
    case 'ACOUSTID_CLIENT_MISSING':
      return t('metadata.musicbrainzAcoustIdClientMissing')
    case 'ACOUSTID_CLIENT_INVALID':
      return t('metadata.acoustidKeyInvalid')
    case 'ACOUSTID_FPCALC_NOT_FOUND':
    case 'ACOUSTID_FPCALC_FAILED':
    case 'ACOUSTID_FPCALC_PARSE_ERROR':
      return t('metadata.musicbrainzAcoustIdToolMissing')
    case 'ACOUSTID_INVALID_PARAMS':
    case 'ACOUSTID_FILE_NOT_FOUND':
      return t('metadata.musicbrainzAcoustIdFileMissing')
    case 'ACOUSTID_NO_FINGERPRINT':
    case 'ACOUSTID_INVALID_DURATION':
      return t('metadata.musicbrainzAcoustIdAnalysisFailed')
    case 'ACOUSTID_TIMEOUT':
      return t('metadata.musicbrainzAcoustIdTimeout')
    case 'ACOUSTID_RATE_LIMITED':
      return t('metadata.musicbrainzAcoustIdRateLimited')
    case 'ACOUSTID_NETWORK':
      return t('metadata.musicbrainzAcoustIdNetworkError')
    case 'MUSICBRAINZ_ABORTED':
    case 'ACOUSTID_ABORTED':
      return ''
  }
  if (normalized.startsWith('ACOUSTID_HTTP_') || normalized === 'ACOUSTID_LOOKUP_FAILED') {
    return t('metadata.musicbrainzAcoustIdUnavailable')
  }
  return t('metadata.musicbrainzGenericError')
}

function ensureAcoustIdKeyReady(triggerMatch: boolean): boolean {
  if (hasAcoustIdKey.value) return true
  pendingFingerprintAfterKey.value = triggerMatch
  acoustIdKeyInput.value = runtime.setting?.acoustIdClientKey || ''
  acoustIdKeyError.value = ''
  showAcoustIdPanel.value = true
  return false
}

function openAcoustIdPanelManually() {
  pendingFingerprintAfterKey.value = false
  acoustIdKeyInput.value = runtime.setting?.acoustIdClientKey || ''
  acoustIdKeyError.value = ''
  showAcoustIdPanel.value = true
}

const persistRuntimeSetting = async () => {
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

async function saveAcoustIdKey() {
  const value = acoustIdKeyInput.value.trim()
  if (!value) {
    acoustIdKeyError.value = t('metadata.acoustidKeyRequired')
    flashBorder('acoustidKey')
    return
  }
  acoustIdKeyError.value = ''
  savingAcoustIdKey.value = true
  try {
    await window.electron.ipcRenderer.invoke('acoustid:validateClientKey', value)
    runtime.setting.acoustIdClientKey = value
    await persistRuntimeSetting()
    showAcoustIdPanel.value = false
    if (pendingFingerprintAfterKey.value) {
      pendingFingerprintAfterKey.value = false
      await matchFingerprint()
    }
  } catch (error) {
    acoustIdKeyError.value =
      mapAcoustIdClientError((error as any)?.message) || t('metadata.acoustidKeySaveFailed')
  } finally {
    savingAcoustIdKey.value = false
  }
}

function cancelAcoustIdSetup() {
  showAcoustIdPanel.value = false
  pendingFingerprintAfterKey.value = false
  acoustIdKeyError.value = ''
}

function openAcoustIdRegister() {
  window.electron.ipcRenderer.send('openLocalBrowser', 'https://acoustid.org/new-application')
}

function triggerFingerprintMatch() {
  if (!ensureAcoustIdKeyReady(true)) return
  void matchFingerprint()
}

async function cancelBackendRequests() {
  try {
    await window.electron.ipcRenderer.invoke('musicbrainz:cancelRequests')
  } catch {}
  try {
    await window.electron.ipcRenderer.invoke('acoustid:cancelRequests')
  } catch {}
}

function onTabClick(tab: 'text' | 'fingerprint') {
  if (activeTab.value === tab) {
    if (tab === 'fingerprint') {
      triggerFingerprintMatch()
    }
    return
  }
  activeTab.value = tab
}

function describeMatchedFields(fields: string[]) {
  if (!Array.isArray(fields) || !fields.length) return ''
  const mapping: Record<string, string> = {
    title: t('metadata.title'),
    artist: t('metadata.artist'),
    album: t('metadata.album'),
    duration: t('columns.duration'),
    fingerprint: t('metadata.musicbrainzMatchFingerprint')
  }
  return fields.map((f) => mapping[f] || f).join(' / ')
}

function buildSearchPayload(): IMusicBrainzSearchPayload | null {
  const title = query.title.trim()
  const artist = query.artist.trim()
  const album = query.album.trim()
  const duration = durationSeconds.value
  if (!title && !artist && !album) return null
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
  state.textResults = []
  state.textHasSearched = false
  state.selectedRecordingIdByTab.text = ''
  state.suggestionByTab.text = null
  state.suggestionErrorByTab.text = ''
  state.suggestionLoadingByTab.text = false
  try {
    const results = (await window.electron.ipcRenderer.invoke(
      'musicbrainz:search',
      payload
    )) as IMusicBrainzMatch[]
    state.textResults = results
    state.textHasSearched = true
    if (!results.length) return
    selectMatch(results[0], 'text')
  } catch (err: any) {
    state.searchError = mapError(err?.message)
    state.textHasSearched = true
  } finally {
    state.searching = false
  }
}

async function matchFingerprint() {
  if (state.fingerprintMatching || state.searching) return
  if (!ensureAcoustIdKeyReady(true)) {
    state.fingerprintError = ''
    return
  }
  state.fingerprintError = ''
  pendingFingerprintAfterKey.value = false
  state.fingerprintMatching = true
  state.fingerprintStatus = 'analyzing'
  state.suggestionByTab.fingerprint = null
  state.suggestionErrorByTab.fingerprint = ''
  state.suggestionLoadingByTab.fingerprint = false
  state.selectedRecordingIdByTab.fingerprint = ''
  state.fingerprintResults = []
  state.fingerprintHasSearched = false
  let lookupPhaseTimer: ReturnType<typeof setTimeout> | null = null
  lookupPhaseTimer = setTimeout(() => {
    if (state.fingerprintMatching) {
      state.fingerprintStatus = 'lookup'
    }
  }, 2000)
  try {
    const matches = (await window.electron.ipcRenderer.invoke('musicbrainz:acoustidMatch', {
      filePath: props.filePath,
      durationSeconds: durationSeconds.value
    })) as IMusicBrainzMatch[]
    state.fingerprintResults = matches
    state.fingerprintHasSearched = true
    if (matches.length) {
      await selectMatch(matches[0], 'fingerprint')
    }
  } catch (err: any) {
    state.fingerprintError = mapError(err?.message)
    state.fingerprintHasSearched = true
  } finally {
    if (lookupPhaseTimer) {
      clearTimeout(lookupPhaseTimer)
    }
    state.fingerprintMatching = false
    state.fingerprintStatus = ''
  }
}

async function selectMatch(match: IMusicBrainzMatch, tab: TabKey = activeTab.value) {
  state.selectedRecordingIdByTab[tab] = match.recordingId
  state.suggestionLoadingByTab[tab] = true
  state.suggestionErrorByTab[tab] = ''
  state.suggestionByTab[tab] = null
  try {
    const result = (await window.electron.ipcRenderer.invoke('musicbrainz:suggest', {
      recordingId: match.recordingId,
      releaseId: match.releaseId
    })) as IMusicBrainzSuggestionResult
    state.suggestionByTab[tab] = result
    applyFieldSelectionsForSuggestion(result, tab)
  } catch (err: any) {
    state.suggestionErrorByTab[tab] = mapError(err?.message)
  } finally {
    state.suggestionLoadingByTab[tab] = false
  }
}

function cacheFieldSelections(tab: TabKey) {
  const cache = fieldSelectionsCache[tab]
  FIELD_KEYS_WITH_COVER.forEach((key) => {
    cache[key] = fieldSelections[key]
  })
}

function restoreFieldSelections(tab: TabKey) {
  const cache = fieldSelectionsCache[tab]
  FIELD_KEYS_WITH_COVER.forEach((key) => {
    fieldSelections[key] = cache[key]
  })
}

function applyFieldSelectionsForSuggestion(
  result: IMusicBrainzSuggestionResult | null,
  tab: TabKey
) {
  const cache = fieldSelectionsCache[tab]
  FIELD_KEYS_WITH_COVER.forEach((key) => {
    cache[key] = false
  })
  if (result) {
    FIELD_KEYS.forEach((key) => {
      const value = result.suggestion[key]
      cache[key] = value !== undefined && value !== null && value !== ''
    })
    cache.cover = result.suggestion.coverDataUrl !== undefined
  }
  if (tab === activeTab.value) {
    restoreFieldSelections(tab)
  }
}

watch(
  () => activeTab.value,
  (tab, prev) => {
    if (prev) {
      cacheFieldSelections(prev)
    }
    restoreFieldSelections(tab)
    if (tab === 'fingerprint') {
      triggerFingerprintMatch()
    }
  },
  { immediate: false }
)

watch(
  fieldSelections,
  () => {
    cacheFieldSelections(activeTab.value)
  },
  { deep: true }
)

function hasIsrcMatch(match: IMusicBrainzMatch) {
  const candidate = normalizeIsrcValue(match.isrc)
  if (!candidate) return false
  const local = localIsrc.value
  return !!local && local === candidate
}

function isAcoustIdMatch(match: IMusicBrainzMatch) {
  return match.source === 'acoustid'
}

function getMatchSourceLabel(match: IMusicBrainzMatch) {
  return match.source === 'acoustid'
    ? t('metadata.musicbrainzSourceAcoustId')
    : t('metadata.musicbrainzSourceSearch')
}

function sourceTagClass(match: IMusicBrainzMatch) {
  return isAcoustIdMatch(match) ? 'tag-source-acoustid' : 'tag-good'
}

function hasLowConfidence(match: IMusicBrainzMatch) {
  return !!match.isLowConfidence
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
  const suggestion = currentSuggestion.value?.suggestion
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
  const suggestion = currentSuggestion.value?.suggestion
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
  const suggestion = currentSuggestion.value?.suggestion
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
  void cancelBackendRequests()
  props.cancelCallback()
}

function autoSearch() {
  const hasInitial =
    (query.title && query.title.trim() !== '') ||
    (query.artist && query.artist.trim() !== '') ||
    (query.album && query.album.trim() !== '')
  if (hasInitial) {
    nextTick(() => searchMusicBrainz())
  }
}

function normalizeText(value?: string | null) {
  if (!value) return ''
  return value.trim()
}

function normalizeIsrcValue(value?: string | null) {
  if (typeof value !== 'string') return ''
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
  void cancelBackendRequests()
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
            <div class="tabs">
              <div class="tab" :class="{ active: isTextTab }" @click="onTabClick('text')">
                {{ t('metadata.musicbrainzTabText') }}
              </div>
              <div class="tab" :class="{ active: !isTextTab }" @click="onTabClick('fingerprint')">
                {{ t('metadata.musicbrainzTabFingerprint') }}
              </div>
            </div>

            <div v-if="isTextTab" class="section">
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
                  :class="{
                    disabled: state.searching || !hasQueryTextInput || state.fingerprintMatching
                  }"
                  @click="
                    state.searching || !hasQueryTextInput || state.fingerprintMatching
                      ? null
                      : searchMusicBrainz()
                  "
                >
                  {{
                    state.searching
                      ? t('metadata.musicbrainzSearching')
                      : t('metadata.musicbrainzSearch')
                  }}
                </div>
              </div>
            </div>

            <div v-else class="section fingerprint-section">
              <div class="section-title">{{ t('metadata.musicbrainzTabFingerprint') }}</div>
              <div class="fingerprint-meta-row">
                <label>{{ t('columns.duration') }}</label>
                <div class="musicbrainz-duration">{{ formatSeconds(durationSeconds) }}</div>
              </div>
              <p class="hint-text">{{ t('metadata.musicbrainzFingerprintIntro') }}</p>
              <div v-if="showAcoustIdPanel" class="acoustid-panel">
                <div class="panel-title">{{ t('metadata.acoustidSetupTitle') }}</div>
                <p>{{ t('metadata.acoustidSettingDesc1') }}</p>
                <p>{{ t('metadata.acoustidSettingDesc2') }}</p>
                <p>{{ t('metadata.acoustidSettingDesc3') }}</p>
                <div class="acoustid-input-row">
                  <input
                    class="flashing-border"
                    :class="{ 'is-flashing': flashArea === 'acoustidKey' }"
                    :placeholder="t('metadata.acoustidKeyPlaceholder')"
                    v-model="acoustIdKeyInput"
                    :disabled="savingAcoustIdKey"
                  />
                  <div class="button secondary" @click="openAcoustIdRegister">
                    {{ t('metadata.acoustidOpenRegister') }}
                  </div>
                </div>
                <div v-if="acoustIdKeyError" class="error-text">{{ acoustIdKeyError }}</div>
                <div class="acoustid-panel-actions">
                  <div
                    class="button"
                    :class="{ disabled: savingAcoustIdKey || !acoustIdKeyInput.trim() }"
                    @click="saveAcoustIdKey"
                  >
                    {{ savingAcoustIdKey ? t('metadata.saving') : t('metadata.acoustidSaveKey') }}
                  </div>
                  <div class="button secondary" @click="cancelAcoustIdSetup">
                    {{ t('common.cancel') }}
                  </div>
                </div>
              </div>
              <div v-else-if="!hasAcoustIdKey" class="hint-text acoustid-inline-hint">
                {{ t('metadata.acoustidMissingHint') }}
                <span class="link-like" @click="openAcoustIdPanelManually">
                  {{ t('metadata.acoustidConfigureNow') }}
                </span>
              </div>
              <div v-else class="hint-text acoustid-inline-hint">
                {{ t('metadata.acoustidSetupDesc3') }}
              </div>
              <div v-if="fingerprintStatusText" class="musicbrainz-fingerprint-status">
                {{ fingerprintStatusText }}
              </div>
            </div>

            <div v-if="displayedResults.length" class="musicbrainz-results">
              <div
                v-for="match in displayedResults"
                :key="match.recordingId"
                class="musicbrainz-result"
                :class="{ active: match.recordingId === currentSelectedRecordingId }"
                @click="selectMatch(match)"
              >
                <div class="result-title-row">
                  <div class="result-title">{{ match.title }}</div>
                  <div class="result-score">
                    {{ t('metadata.musicbrainzScore', { score: match.score }) }}
                  </div>
                </div>
                <div class="result-meta-lines">
                  <div class="result-meta-line" v-if="match.artist">
                    <span class="result-meta-label">{{ t('metadata.artist') }}</span>
                    <span class="result-meta-value">{{ match.artist }}</span>
                  </div>
                  <div class="result-meta-line" v-if="match.releaseTitle">
                    <span class="result-meta-label">{{ t('metadata.album') }}</span>
                    <span class="result-meta-value">{{ match.releaseTitle }}</span>
                  </div>
                  <div class="result-meta-line" v-if="match.durationSeconds">
                    <span class="result-meta-label">{{ t('columns.duration') }}</span>
                    <span class="result-meta-value">
                      {{ formatSeconds(match.durationSeconds) }}
                    </span>
                  </div>
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
                  v-if="
                    match.source ||
                    shouldShowDurationDiff(match) ||
                    hasIsrcMatch(match) ||
                    hasLowConfidence(match)
                  "
                >
                  <span v-if="match.source" class="tag" :class="sourceTagClass(match)">
                    {{ getMatchSourceLabel(match) }}
                  </span>
                  <span v-if="hasLowConfidence(match)" class="tag tag-warn">
                    {{ t('metadata.musicbrainzLowConfidence') }}
                  </span>
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
            <div v-else-if="currentErrorMessage" class="error-text">
              {{ currentErrorMessage }}
            </div>
            <div v-else-if="shouldShowEmptyState" class="musicbrainz-empty">
              {{ t('metadata.musicbrainzNoResult') }}
            </div>

            <div class="musicbrainz-suggestion">
              <div v-if="currentSuggestionLoading" class="musicbrainz-loading">
                {{ t('metadata.musicbrainzLoadingSuggestion') }}
              </div>
              <div v-else-if="currentSuggestionError" class="error-text">
                {{ currentSuggestionError }}
              </div>
              <div v-else-if="currentSuggestion" class="musicbrainz-suggestion-body">
                <div class="musicbrainz-suggestion-meta">
                  <div>
                    {{ t('metadata.musicbrainzChosenRelease') }}：
                    {{ currentSuggestion.releaseTitle || '--' }}
                  </div>
                  <div>
                    {{ t('metadata.musicbrainzReleaseDate') }}：
                    {{ currentSuggestion.releaseDate || '--' }}
                  </div>
                  <div>
                    {{ t('metadata.musicbrainzLabel') }}：
                    {{ currentSuggestion.label || '--' }}
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

.tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}

.tab {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary, #888);
  border-bottom: 2px solid transparent;
}

.tab.active {
  color: var(--accent);
  border-color: var(--accent);
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
  flex-wrap: wrap;
}

.musicbrainz-panel-actions .button.secondary {
  background-color: transparent;
  border: 1px solid var(--border);
  color: var(--text);
}

.fingerprint-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fingerprint-meta-row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--text-secondary, #888);
}

.musicbrainz-fingerprint-status {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.hint-text {
  font-size: 12px;
  color: var(--text-secondary, #888);
  margin-top: 6px;
  line-height: 1.4;
}

.acoustid-inline-hint .link-like {
  margin-left: 6px;
}

.link-like {
  color: var(--accent);
  cursor: pointer;
}

.acoustid-panel {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  margin-top: 12px;
  background-color: rgba(0, 0, 0, 0.03);
}

.acoustid-panel .panel-title {
  font-weight: bold;
  margin-bottom: 6px;
}

.acoustid-panel p {
  margin: 4px 0;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.acoustid-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 10px 0;
}

.acoustid-input-row input {
  flex: 1;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 8px;
  background-color: var(--bg);
  color: var(--text);
  outline: none;
}

.acoustid-input-row input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
}

.acoustid-panel-actions {
  margin-top: 8px;
  display: flex;
  gap: 10px;
}

.acoustid-panel .button.secondary {
  background-color: transparent;
  border: 1px solid var(--border);
  color: var(--text);
}

.musicbrainz-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.result-meta.small {
  font-size: 11px;
}

.result-meta-lines {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 2px;
}

.result-meta-line {
  display: flex;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.result-meta-label {
  min-width: 52px;
  color: var(--text-secondary, #777);
}

.result-meta-value {
  flex: 1;
  color: var(--text);
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

.tag-source-acoustid {
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

.error-text {
  color: #e81123;
  font-size: 12px;
  margin-top: 6px;
}
</style>
