import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { t } from '@renderer/utils/translate'
import hotkeys from 'hotkeys-js'
import utils from '@renderer/utils/utils'
import { mapAcoustIdClientError } from '@renderer/utils/acoustid'
import { v4 as uuidV4 } from 'uuid'
import { useRuntimeStore } from '@renderer/stores/runtime'
import type {
  IMusicBrainzMatch,
  IMusicBrainzSuggestionResult,
  IMusicBrainzSearchPayload,
  IMusicBrainzApplyPayload
} from 'src/types/globals'

export type MusicBrainzDialogInitialQuery = {
  title?: string
  artist?: string
  album?: string
  durationSeconds?: number
  isrc?: string
}

export interface MusicBrainzDialogProps {
  filePath: string
  initialQuery?: MusicBrainzDialogInitialQuery
  confirmCallback: (payload: { payload: IMusicBrainzApplyPayload }) => void
  cancelCallback: () => void
}

type TabKey = 'text' | 'fingerprint'
type FieldKey =
  | 'title'
  | 'artist'
  | 'album'
  | 'albumArtist'
  | 'year'
  | 'genre'
  | 'label'
  | 'isrc'
  | 'trackNo'
  | 'trackTotal'
  | 'discNo'
  | 'discTotal'
type FieldKeyWithCover = FieldKey | 'cover'

export function useMusicBrainzDialog(props: MusicBrainzDialogProps) {
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

  const query = reactive({
    title: props.initialQuery?.title || '',
    artist: props.initialQuery?.artist || '',
    album: ''
  })
  const durationSeconds = ref<number | undefined>(props.initialQuery?.durationSeconds)
  const localIsrc = computed(() => normalizeIsrcValue(props.initialQuery?.isrc))

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

  const FIELD_KEYS: readonly FieldKey[] = [
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
  ]
  const FIELD_KEYS_WITH_COVER: FieldKeyWithCover[] = [...FIELD_KEYS, 'cover']
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

  function createDefaultFieldSelections() {
    const defaults: Record<FieldKeyWithCover, boolean> = {} as Record<FieldKeyWithCover, boolean>
    FIELD_KEYS_WITH_COVER.forEach((key) => {
      defaults[key] = true
    })
    return defaults
  }

  const fieldSelections = reactive<Record<FieldKeyWithCover, boolean>>(
    createDefaultFieldSelections()
  )
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

  function onTabClick(tab: TabKey) {
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
    }
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

  return {
    runtime,
    flashArea,
    flashBorder,
    query,
    durationSeconds,
    state,
    activeTab,
    isTextTab,
    showAcoustIdPanel,
    acoustIdKeyInput,
    acoustIdKeyError,
    savingAcoustIdKey,
    hasAcoustIdKey,
    hasQueryTextInput,
    fingerprintStatusText,
    displayedResults,
    currentSelectedRecordingId,
    currentSuggestion,
    currentSuggestionError,
    currentSuggestionLoading,
    currentErrorMessage,
    shouldShowEmptyState,
    suggestionCoverDataUrl,
    fieldMeta,
    fieldSelections,
    canConfirm,
    searchMusicBrainz,
    triggerFingerprintMatch,
    openAcoustIdPanelManually,
    saveAcoustIdKey,
    cancelAcoustIdSetup,
    openAcoustIdRegister,
    selectMatch,
    hasMusicBrainzValue,
    getFieldText,
    describeMatchedFields,
    shouldShowDurationDiff,
    durationDiffClass,
    durationDiffText,
    hasIsrcMatch,
    hasLowConfidence,
    getMatchSourceLabel,
    sourceTagClass,
    formatSeconds,
    handleConfirm,
    handleCancel,
    onTabClick
  }
}
