<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { t } from '@renderer/utils/translate'
import hotkeys from 'hotkeys-js'
import utils from '@renderer/utils/utils'
import { v4 as uuidV4 } from 'uuid'
import type {
  ITrackMetadataDetail,
  ITrackMetadataUpdatePayload,
  IMusicBrainzMatch,
  IMusicBrainzSuggestionResult,
  IMusicBrainzSearchPayload
} from 'src/types/globals'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'

const uuid = uuidV4()

const props = defineProps({
  filePath: {
    type: String,
    required: true
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

const loading = ref(true)
const loadError = ref('')
const submitting = ref(false)
const errorMessage = ref('')

const currentFilePath = ref(props.filePath)
const fileName = ref('')
const originalFileName = ref('')
const fileExtension = ref('')
const fileNameError = ref('')

const form = reactive({
  title: '',
  artist: '',
  album: '',
  albumArtist: '',
  trackNo: '',
  trackTotal: '',
  discNo: '',
  discTotal: '',
  year: '',
  genre: '',
  composer: '',
  lyricist: '',
  label: '',
  isrc: '',
  comment: '',
  lyrics: ''
})

const metadataDetail = ref<ITrackMetadataDetail | null>(null)

const coverDataUrl = ref<string | null>(null)
const originalCoverDataUrl = ref<string | null>(null)

const fileInputRef = ref<HTMLInputElement | null>(null)
const isRemoveDisabled = computed(() => submitting.value || !coverDataUrl.value)
const showRestoreButton = computed(() => !!originalCoverDataUrl.value)
const isRestoreDisabled = computed(
  () =>
    submitting.value ||
    !originalCoverDataUrl.value ||
    coverDataUrl.value === originalCoverDataUrl.value
)

const invalidFileNameRegex = /[<>:"/\\|?*\u0000-\u001F]/
const flashArea = ref('')
let flashTimer: any = null
let flashCount = 0

const MUSICBRAINZ_FIELD_SEQUENCE = [
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
type MusicBrainzFieldKey = (typeof MUSICBRAINZ_FIELD_SEQUENCE)[number]
type MusicBrainzFieldKeyWithCover = MusicBrainzFieldKey | 'cover'
const MUSICBRAINZ_FIELD_DEFS: Array<{ key: MusicBrainzFieldKeyWithCover; labelKey: string }> = [
  { key: 'title', labelKey: 'metadata.title' },
  { key: 'artist', labelKey: 'metadata.artist' },
  { key: 'album', labelKey: 'metadata.album' },
  { key: 'albumArtist', labelKey: 'metadata.albumArtist' },
  { key: 'year', labelKey: 'metadata.year' },
  { key: 'genre', labelKey: 'metadata.genre' },
  { key: 'label', labelKey: 'metadata.label' },
  { key: 'isrc', labelKey: 'metadata.isrc' },
  { key: 'trackNo', labelKey: 'metadata.trackNo' },
  { key: 'trackTotal', labelKey: 'metadata.trackTotal' },
  { key: 'discNo', labelKey: 'metadata.discNo' },
  { key: 'discTotal', labelKey: 'metadata.discTotal' },
  { key: 'cover', labelKey: 'metadata.cover' }
]

const musicBrainzPanelOpen = ref(false)
const musicBrainzState = reactive({
  query: {
    title: '',
    artist: '',
    album: ''
  },
  searching: false,
  searchError: '',
  results: [] as IMusicBrainzMatch[],
  hasSearched: false,
  suggestionLoading: false,
  suggestionError: '',
  selectedRecordingId: '',
  suggestion: null as IMusicBrainzSuggestionResult | null,
  applyMessage: '',
  lastQueryDurationSeconds: undefined as number | undefined
})
const musicBrainzFieldSelections = reactive<Record<MusicBrainzFieldKeyWithCover, boolean>>({
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
let musicBrainzApplyTimer: number | null = null
const resolvedLocalIsrc = computed(
  () => normalizeIsrcValue(form.isrc) || normalizeIsrcValue(metadataDetail.value?.isrc)
)

function resetForm(detail: ITrackMetadataDetail) {
  form.title = detail.title ?? ''
  form.artist = detail.artist ?? ''
  form.album = detail.album ?? ''
  form.albumArtist = detail.albumArtist ?? ''
  form.trackNo =
    detail.trackNo !== undefined && detail.trackNo !== null ? String(detail.trackNo) : ''
  form.trackTotal =
    detail.trackTotal !== undefined && detail.trackTotal !== null ? String(detail.trackTotal) : ''
  form.discNo = detail.discNo !== undefined && detail.discNo !== null ? String(detail.discNo) : ''
  form.discTotal =
    detail.discTotal !== undefined && detail.discTotal !== null ? String(detail.discTotal) : ''
  form.year = detail.year ?? ''
  form.genre = detail.genre ?? ''
  form.composer = detail.composer ?? ''
  form.lyricist = detail.lyricist ?? ''
  form.label = detail.label ?? ''
  form.isrc = detail.isrc ?? ''
  form.comment = detail.comment ?? ''
  form.lyrics = detail.lyrics ?? ''
  coverDataUrl.value = detail.cover?.dataUrl ?? null
  originalCoverDataUrl.value = detail.cover?.dataUrl ?? null
  updateFileNameState(detail.filePath, detail.fileName, detail.fileExtension)
}

async function ensureCover(detail: ITrackMetadataDetail) {
  if (detail.cover && detail.cover.dataUrl) {
    coverDataUrl.value = detail.cover.dataUrl
    originalCoverDataUrl.value = detail.cover.dataUrl
    return
  }
  try {
    const thumb = (await window.electron.ipcRenderer.invoke(
      'getSongCoverThumb',
      detail.filePath,
      256,
      ''
    )) as { format: string; data?: Uint8Array | { data: number[] }; dataUrl?: string } | null
    if (thumb) {
      if (thumb.dataUrl) {
        coverDataUrl.value = thumb.dataUrl
        originalCoverDataUrl.value = thumb.dataUrl
      } else if (thumb.data) {
        const raw: any = thumb.data
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw.data || raw)
        let binary = ''
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i])
        }
        const base64 = window.btoa(binary)
        const dataUrl = `data:${thumb.format || 'image/jpeg'};base64,${base64}`
        coverDataUrl.value = dataUrl
        originalCoverDataUrl.value = dataUrl
      } else {
        coverDataUrl.value = null
        originalCoverDataUrl.value = null
      }
    } else {
      coverDataUrl.value = null
      originalCoverDataUrl.value = null
    }
  } catch {
    coverDataUrl.value = null
    originalCoverDataUrl.value = null
  }
}

function updateFileNameState(filePath: string, baseName?: string, extension?: string) {
  currentFilePath.value = filePath
  const normalized = filePath.replace(/\\/g, '/')
  const filePart = normalized.split('/').pop() || ''
  let nameWithoutExt = baseName
  let ext = extension
  if (!nameWithoutExt || !ext) {
    const dotIndex = filePart.lastIndexOf('.')
    if (!nameWithoutExt) {
      nameWithoutExt = dotIndex >= 0 ? filePart.slice(0, dotIndex) : filePart
    }
    if (!ext) {
      ext = dotIndex >= 0 ? filePart.slice(dotIndex) : ''
    }
  }
  originalFileName.value = nameWithoutExt || ''
  fileName.value = nameWithoutExt || ''
  fileExtension.value = ext || ''
  fileNameError.value = ''
}

function validateFileName(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed === '') {
    fileNameError.value = t('metadata.fileNameRequired')
    return false
  }
  if (invalidFileNameRegex.test(trimmed)) {
    fileNameError.value = t('metadata.fileNameInvalid')
    return false
  }
  if (trimmed === '.' || trimmed === '..' || /[ .]$/.test(trimmed)) {
    fileNameError.value = t('metadata.fileNameInvalid')
    return false
  }
  fileNameError.value = ''
  return true
}

function onFileNameInput() {
  errorMessage.value = ''
  validateFileName(fileName.value)
}

function flashFileNameInput() {
  flashArea.value = 'fileName'
  flashCount = 0
  clearInterval(flashTimer)
  flashTimer = setInterval(() => {
    flashCount++
    if (flashCount >= 3) {
      clearInterval(flashTimer)
      flashArea.value = ''
    }
  }, 500)
}

function resetMusicBrainzState(detail?: ITrackMetadataDetail | null) {
  musicBrainzState.results = []
  musicBrainzState.searchError = ''
  musicBrainzState.hasSearched = false
  musicBrainzState.suggestionLoading = false
  musicBrainzState.suggestionError = ''
  musicBrainzState.selectedRecordingId = ''
  musicBrainzState.suggestion = null
  musicBrainzState.applyMessage = ''
  musicBrainzPanelOpen.value = false
  if (musicBrainzApplyTimer) {
    clearTimeout(musicBrainzApplyTimer)
    musicBrainzApplyTimer = null
  }
  if (detail) {
    musicBrainzState.query.title = detail.title || ''
    musicBrainzState.query.artist = detail.artist || ''
    musicBrainzState.query.album = detail.album || ''
    musicBrainzState.lastQueryDurationSeconds = detail.durationSeconds
  }
  if (musicBrainzPanelOpen.value) {
    nextTick(() => autoSearchMusicBrainzIfNeeded())
  }
}

function syncMusicBrainzQueryFromForm() {
  musicBrainzState.query.title = form.title || metadataDetail.value?.title || ''
  musicBrainzState.query.artist = form.artist || metadataDetail.value?.artist || ''
  musicBrainzState.query.album = form.album || metadataDetail.value?.album || ''
  musicBrainzState.lastQueryDurationSeconds = metadataDetail.value?.durationSeconds
}

function toggleMusicBrainzPanel() {
  musicBrainzPanelOpen.value = !musicBrainzPanelOpen.value
  if (musicBrainzPanelOpen.value) {
    syncMusicBrainzQueryFromForm()
    nextTick(() => autoSearchMusicBrainzIfNeeded())
  }
}

function formatSeconds(seconds?: number) {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) return '--:--'
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function mapMusicBrainzError(code?: string) {
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
  return fields.map((field) => mapping[field] || field).join(' / ')
}

function buildMusicBrainzSearchPayload(): IMusicBrainzSearchPayload | null {
  const title = musicBrainzState.query.title?.trim()
  const artist = musicBrainzState.query.artist?.trim()
  const album = musicBrainzState.query.album?.trim()
  const durationSeconds = musicBrainzState.lastQueryDurationSeconds
  if (!title && !artist && !album && !durationSeconds) {
    return null
  }
  return {
    filePath: currentFilePath.value,
    title: title || undefined,
    artist: artist || undefined,
    album: album || undefined,
    durationSeconds
  }
}

function autoSearchMusicBrainzIfNeeded() {
  if (!musicBrainzPanelOpen.value) return
  if (musicBrainzState.searching || musicBrainzState.hasSearched) return
  const payload = buildMusicBrainzSearchPayload()
  if (!payload) return
  searchMusicBrainz({ silent: true })
}

function normalizeIsrcValue(value?: string | null) {
  if (!value) return ''
  const trimmed = value.trim()
  return trimmed === '' ? '' : trimmed.toUpperCase()
}

function hasIsrcMatch(match: IMusicBrainzMatch) {
  const candidate = normalizeIsrcValue(match?.isrc)
  if (!candidate) return false
  const localIsrc = resolvedLocalIsrc.value
  return !!localIsrc && localIsrc === candidate
}

function shouldShowDurationDiff(match: IMusicBrainzMatch) {
  return typeof match?.durationDiffSeconds === 'number'
}

function getDurationDiffClass(diff?: number) {
  if (typeof diff !== 'number') return ''
  if (diff <= 2) return 'tag-good'
  if (diff > 6) return 'tag-warn'
  return ''
}

function getDurationDiffText(diff?: number) {
  if (typeof diff !== 'number') return ''
  return t('metadata.musicbrainzDurationDiff', { seconds: diff })
}

function resetMusicBrainzSelections(result: IMusicBrainzSuggestionResult | null) {
  ;(Object.keys(musicBrainzFieldSelections) as MusicBrainzFieldKeyWithCover[]).forEach((key) => {
    musicBrainzFieldSelections[key] = false
  })
  if (!result) return
  MUSICBRAINZ_FIELD_SEQUENCE.forEach((key) => {
    const value = result.suggestion[key]
    musicBrainzFieldSelections[key] = value !== undefined && value !== null && value !== ''
  })
  musicBrainzFieldSelections.cover = result.suggestion.coverDataUrl !== undefined
}

function hasMusicBrainzValue(key: MusicBrainzFieldKeyWithCover) {
  const suggestion = musicBrainzState.suggestion?.suggestion
  if (!suggestion) return false
  if (key === 'cover') {
    return suggestion.coverDataUrl !== undefined && suggestion.coverDataUrl !== null
  }
  const value = suggestion[key as MusicBrainzFieldKey]
  return value !== undefined && value !== null && value !== ''
}

function getMusicBrainzValueText(key: MusicBrainzFieldKeyWithCover) {
  const suggestion = musicBrainzState.suggestion?.suggestion
  if (!suggestion) return ''
  if (key === 'cover') {
    if (suggestion.coverDataUrl === null || suggestion.coverDataUrl === undefined) return ''
    return t('metadata.musicbrainzCoverReady')
  }
  const value = suggestion[key as MusicBrainzFieldKey]
  if (value === undefined || value === null) return ''
  return typeof value === 'number' ? String(value) : value
}

async function searchMusicBrainz(options?: { silent?: boolean }) {
  if (musicBrainzState.searching) return
  const payload = buildMusicBrainzSearchPayload()
  if (!payload) {
    if (!options?.silent) {
      musicBrainzState.searchError = t('metadata.musicbrainzNeedKeyword')
    }
    return
  }
  musicBrainzState.searching = true
  musicBrainzState.searchError = ''
  musicBrainzState.results = []
  musicBrainzState.suggestion = null
  musicBrainzState.selectedRecordingId = ''
  try {
    const results = (await window.electron.ipcRenderer.invoke(
      'musicbrainz:search',
      payload
    )) as IMusicBrainzMatch[]
    musicBrainzState.results = results
    musicBrainzState.hasSearched = true
    if (!results.length) {
      musicBrainzState.suggestion = null
      return
    }
    const first = results[0]
    musicBrainzState.selectedRecordingId = first.recordingId
    await loadMusicBrainzSuggestion(first)
  } catch (err: any) {
    musicBrainzState.searchError = mapMusicBrainzError(err?.message)
    musicBrainzState.hasSearched = true
  } finally {
    musicBrainzState.searching = false
  }
}

async function loadMusicBrainzSuggestion(match: IMusicBrainzMatch) {
  if (!match) return
  musicBrainzState.suggestionLoading = true
  musicBrainzState.suggestionError = ''
  musicBrainzState.suggestion = null
  try {
    const result = (await window.electron.ipcRenderer.invoke('musicbrainz:suggest', {
      recordingId: match.recordingId,
      releaseId: match.releaseId
    })) as IMusicBrainzSuggestionResult
    musicBrainzState.suggestion = result
    resetMusicBrainzSelections(result)
  } catch (err: any) {
    musicBrainzState.suggestionError = mapMusicBrainzError(err?.message)
  } finally {
    musicBrainzState.suggestionLoading = false
  }
}

function onSelectMusicBrainzMatch(match: IMusicBrainzMatch) {
  if (!match) return
  if (musicBrainzState.selectedRecordingId === match.recordingId && musicBrainzState.suggestion)
    return
  musicBrainzState.selectedRecordingId = match.recordingId
  loadMusicBrainzSuggestion(match)
}

function applyMusicBrainzSuggestion() {
  if (!musicBrainzState.suggestion) return
  const suggestion = musicBrainzState.suggestion.suggestion
  const applyStringField = (key: MusicBrainzFieldKey, setter: (value: string) => void) => {
    if (!musicBrainzFieldSelections[key]) return
    const value = suggestion[key]
    if (value === undefined || value === null) return
    setter(typeof value === 'number' ? String(value) : value)
  }
  applyStringField('title', (value) => {
    form.title = value
  })
  applyStringField('artist', (value) => {
    form.artist = value
  })
  applyStringField('album', (value) => {
    form.album = value
  })
  applyStringField('albumArtist', (value) => {
    form.albumArtist = value
  })
  applyStringField('year', (value) => {
    form.year = value
  })
  applyStringField('genre', (value) => {
    form.genre = value
  })
  applyStringField('label', (value) => {
    form.label = value
  })
  applyStringField('isrc', (value) => {
    form.isrc = value
  })
  if (musicBrainzFieldSelections.trackNo && typeof suggestion.trackNo === 'number') {
    form.trackNo = String(suggestion.trackNo)
  }
  if (musicBrainzFieldSelections.trackTotal && typeof suggestion.trackTotal === 'number') {
    form.trackTotal = String(suggestion.trackTotal)
  }
  if (musicBrainzFieldSelections.discNo && typeof suggestion.discNo === 'number') {
    form.discNo = String(suggestion.discNo)
  }
  if (musicBrainzFieldSelections.discTotal && typeof suggestion.discTotal === 'number') {
    form.discTotal = String(suggestion.discTotal)
  }
  if (musicBrainzFieldSelections.cover) {
    if (suggestion.coverDataUrl !== undefined) {
      coverDataUrl.value = suggestion.coverDataUrl
    }
  }
  musicBrainzState.applyMessage = t('metadata.musicbrainzApplied')
  if (musicBrainzApplyTimer) clearTimeout(musicBrainzApplyTimer)
  musicBrainzApplyTimer = window.setTimeout(() => {
    musicBrainzState.applyMessage = ''
    musicBrainzApplyTimer = null
  }, 3500)
}

async function loadMetadata() {
  loading.value = true
  loadError.value = ''
  errorMessage.value = ''
  try {
    const detail = (await window.electron.ipcRenderer.invoke(
      'audio:metadata:get',
      props.filePath
    )) as ITrackMetadataDetail | null
    if (detail) {
      metadataDetail.value = detail
      resetForm(detail)
      await ensureCover(detail)
      resetMusicBrainzState(detail)
    } else {
      loadError.value = t('metadata.loadFailed')
    }
  } catch (err: any) {
    loadError.value = t('metadata.loadFailed')
  } finally {
    loading.value = false
  }
}

function onFileButtonClick() {
  if (fileInputRef.value) {
    fileInputRef.value.value = ''
    fileInputRef.value.click()
  }
}

function normalizeText(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function parsePositiveInt(value: string, errorKey: string): number | null | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const num = Number(trimmed)
  if (!Number.isInteger(num) || num <= 0) {
    errorMessage.value = t(errorKey)
    return null
  }
  return num
}

async function onConfirm() {
  if (loading.value || submitting.value) return
  errorMessage.value = ''
  fileNameError.value = ''

  if (!validateFileName(fileName.value)) {
    flashFileNameInput()
    return
  }

  const trackNo = parsePositiveInt(form.trackNo, 'metadata.trackNumberError')
  if (trackNo === null) return
  const trackTotal = parsePositiveInt(form.trackTotal, 'metadata.trackTotalError')
  if (trackTotal === null) return
  const discNo = parsePositiveInt(form.discNo, 'metadata.discNumberError')
  if (discNo === null) return
  const discTotal = parsePositiveInt(form.discTotal, 'metadata.discTotalError')
  if (discTotal === null) return

  const trimmedFileName = fileName.value.trim()

  const payload: ITrackMetadataUpdatePayload = {
    filePath: currentFilePath.value,
    title: normalizeText(form.title),
    artist: normalizeText(form.artist),
    album: normalizeText(form.album),
    albumArtist: normalizeText(form.albumArtist),
    trackNo: trackNo,
    trackTotal: trackTotal,
    discNo: discNo,
    discTotal: discTotal,
    year: normalizeText(form.year),
    genre: normalizeText(form.genre),
    composer: normalizeText(form.composer),
    lyricist: normalizeText(form.lyricist),
    label: normalizeText(form.label),
    isrc: normalizeText(form.isrc),
    comment: normalizeText(form.comment),
    lyrics: normalizeText(form.lyrics),
    coverDataUrl: coverDataUrl.value
  }

  if (trimmedFileName !== originalFileName.value) {
    payload.newBaseName = trimmedFileName
  }

  submitting.value = true
  try {
    const response = (await window.electron.ipcRenderer.invoke(
      'audio:metadata:update',
      payload
    )) as {
      success: boolean
      songInfo?: any
      detail?: ITrackMetadataDetail
      renamedFrom?: string
      message?: string
    }
    if (!response || response.success !== true || !response.songInfo || !response.detail) {
      const code = response?.message
      if (code === 'INVALID_FILE_NAME') {
        fileNameError.value = t('metadata.fileNameInvalid')
        flashFileNameInput()
        submitting.value = false
        return
      }
      if (code === 'FILE_NAME_EXISTS') {
        fileNameError.value = t('metadata.fileNameExists')
        flashFileNameInput()
        submitting.value = false
        return
      }
      const fallback = code && code.trim() !== '' ? code : t('common.error')
      errorMessage.value = t('metadata.saveFailed', { message: fallback })
      submitting.value = false
      return
    }

    const previousFilePath = currentFilePath.value
    updateFileNameState(
      response.detail.filePath,
      response.detail.fileName,
      response.detail.fileExtension
    )
    metadataDetail.value = response.detail
    await ensureCover(response.detail)
    submitting.value = false
    props.confirmCallback({
      updatedSongInfo: response.songInfo,
      detail: response.detail,
      oldFilePath: response.renamedFrom ?? previousFilePath
    })
  } catch (err: any) {
    const code = err?.message
    if (code === 'INVALID_FILE_NAME') {
      fileNameError.value = t('metadata.fileNameInvalid')
      flashFileNameInput()
    } else if (code === 'FILE_NAME_EXISTS') {
      fileNameError.value = t('metadata.fileNameExists')
      flashFileNameInput()
    } else {
      const fallback = code && String(code).trim() !== '' ? code : t('common.error')
      errorMessage.value = t('metadata.saveFailed', { message: fallback })
    }
    submitting.value = false
  }
}

function onCancel() {
  if (submitting.value) return
  props.cancelCallback()
}

function onRemoveCover() {
  if (isRemoveDisabled.value) return
  coverDataUrl.value = null
}

function onRestoreCover() {
  if (isRestoreDisabled.value) return
  coverDataUrl.value = originalCoverDataUrl.value
}

async function onCoverSelected(event: Event) {
  errorMessage.value = ''
  const target = event.target as HTMLInputElement
  const file = target?.files?.[0]
  if (!file) return
  if (file.size > 5 * 1024 * 1024) {
    errorMessage.value = t('metadata.saveFailed', { message: t('metadata.coverTooLarge') })
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const result = reader.result
    if (typeof result === 'string') {
      coverDataUrl.value = result
    }
  }
  reader.readAsDataURL(file)
}

onMounted(() => {
  updateFileNameState(props.filePath)
  loadMetadata()
  hotkeys('E,Enter', uuid, () => {
    onConfirm()
    return false
  })
  hotkeys('Esc', uuid, () => {
    onCancel()
    return false
  })
  utils.setHotkeysScpoe(uuid)
})

onUnmounted(() => {
  utils.delHotkeysScope(uuid)
  clearInterval(flashTimer)
  if (musicBrainzApplyTimer) {
    clearTimeout(musicBrainzApplyTimer)
    musicBrainzApplyTimer = null
  }
})
</script>

<template>
  <div class="dialog unselectable">
    <div class="inner" v-dialog-drag="'.dialog-title'">
      <div class="top-block">
        <div class="dialog-title">{{ t('metadata.dialogTitle') }}</div>
        <div class="body">
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
            <div class="content">
              <div class="section">
                <div class="section-title">{{ t('metadata.fileName') }}</div>
                <div class="filename-row">
                  <div class="filename-input-wrapper">
                    <input
                      v-model="fileName"
                      class="myInput flashing-border"
                      :class="{
                        myInputRedBorder: fileNameError,
                        'is-flashing-error': flashArea === 'fileName'
                      }"
                      :disabled="submitting"
                      @input="onFileNameInput"
                      @keydown.enter.prevent="onConfirm"
                    />
                    <div v-if="fileNameError" class="myInputHint">
                      <div>{{ fileNameError }}</div>
                    </div>
                  </div>
                  <span class="filename-extension">{{ fileExtension }}</span>
                </div>
              </div>

              <div class="path-row">
                <label>{{ t('metadata.filePath') }}</label>
                <div class="path-value" :title="currentFilePath">{{ currentFilePath }}</div>
              </div>

              <div v-if="loading" class="loading">{{ t('metadata.loading') }}</div>
              <div v-else-if="loadError" class="error-block">
                <span>{{ loadError }}</span>
                <div class="button text-button" @click="loadMetadata">{{ t('common.retry') }}</div>
              </div>
              <div v-else class="form-body">
                <div class="section musicbrainz-section">
                  <div class="musicbrainz-toggle-row">
                    <div>
                      <div class="section-title">{{ t('metadata.musicbrainzTitle') }}</div>
                      <div class="musicbrainz-hint">{{ t('metadata.musicbrainzHint') }}</div>
                    </div>
                    <div class="musicbrainz-toggle-actions">
                      <div
                        class="button text-button"
                        :class="{ disabled: musicBrainzState.searching }"
                        @click="musicBrainzState.searching ? null : syncMusicBrainzQueryFromForm()"
                      >
                        {{ t('metadata.musicbrainzSync') }}
                      </div>
                      <div class="button" @click="toggleMusicBrainzPanel">
                        {{
                          musicBrainzPanelOpen
                            ? t('metadata.musicbrainzHidePanel')
                            : t('metadata.musicbrainzShowPanel')
                        }}
                      </div>
                    </div>
                  </div>
                  <div v-if="musicBrainzPanelOpen" class="musicbrainz-panel">
                    <div class="musicbrainz-query-grid">
                      <label>{{ t('metadata.title') }}</label>
                      <input
                        v-model="musicBrainzState.query.title"
                        :disabled="musicBrainzState.searching"
                      />
                      <label>{{ t('metadata.artist') }}</label>
                      <input
                        v-model="musicBrainzState.query.artist"
                        :disabled="musicBrainzState.searching"
                      />
                      <label>{{ t('metadata.album') }}</label>
                      <input
                        v-model="musicBrainzState.query.album"
                        :disabled="musicBrainzState.searching"
                      />
                      <label>{{ t('columns.duration') }}</label>
                      <div class="musicbrainz-duration">
                        {{ formatSeconds(musicBrainzState.lastQueryDurationSeconds) }}
                      </div>
                    </div>
                    <div class="musicbrainz-panel-actions">
                      <div
                        class="button"
                        :class="{ disabled: musicBrainzState.searching }"
                        @click="musicBrainzState.searching ? null : searchMusicBrainz()"
                      >
                        {{
                          musicBrainzState.searching
                            ? t('metadata.musicbrainzSearching')
                            : t('metadata.musicbrainzSearch')
                        }}
                      </div>
                    </div>
                    <div v-if="musicBrainzState.searchError" class="error-text">
                      {{ musicBrainzState.searchError }}
                    </div>
                    <div
                      v-else-if="
                        musicBrainzState.hasSearched && musicBrainzState.results.length === 0
                      "
                      class="musicbrainz-empty"
                    >
                      {{ t('metadata.musicbrainzNoResult') }}
                    </div>
                    <div v-if="musicBrainzState.results.length" class="musicbrainz-results">
                      <div
                        v-for="match in musicBrainzState.results"
                        :key="match.recordingId"
                        class="musicbrainz-result"
                        :class="{
                          active: match.recordingId === musicBrainzState.selectedRecordingId
                        }"
                        @click="onSelectMusicBrainzMatch(match)"
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
                            :class="getDurationDiffClass(match.durationDiffSeconds)"
                          >
                            {{ getDurationDiffText(match.durationDiffSeconds) }}
                          </span>
                          <span v-if="hasIsrcMatch(match)" class="tag tag-good">
                            {{ t('metadata.musicbrainzIsrcMatch') }}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div class="musicbrainz-suggestion">
                      <div v-if="musicBrainzState.suggestionLoading" class="musicbrainz-loading">
                        {{ t('metadata.musicbrainzLoadingSuggestion') }}
                      </div>
                      <div v-else-if="musicBrainzState.suggestionError" class="error-text">
                        {{ musicBrainzState.suggestionError }}
                      </div>
                      <div
                        v-else-if="musicBrainzState.suggestion"
                        class="musicbrainz-suggestion-body"
                      >
                        <div class="musicbrainz-suggestion-meta">
                          <div>
                            {{ t('metadata.musicbrainzChosenRelease') }}：
                            {{ musicBrainzState.suggestion.releaseTitle || '--' }}
                          </div>
                          <div>
                            {{ t('metadata.musicbrainzReleaseDate') }}：
                            {{ musicBrainzState.suggestion.releaseDate || '--' }}
                          </div>
                          <div>
                            {{ t('metadata.musicbrainzLabel') }}：
                            {{ musicBrainzState.suggestion.label || '--' }}
                          </div>
                        </div>
                        <div class="musicbrainz-field-grid">
                          <label
                            v-for="field in MUSICBRAINZ_FIELD_DEFS"
                            :key="field.key"
                            :class="{ disabled: !hasMusicBrainzValue(field.key) }"
                          >
                            <input
                              type="checkbox"
                              v-model="musicBrainzFieldSelections[field.key]"
                              :disabled="!hasMusicBrainzValue(field.key)"
                            />
                            <span class="field-name">{{ t(field.labelKey) }}</span>
                            <span class="field-value">
                              {{ getMusicBrainzValueText(field.key) || '--' }}
                            </span>
                          </label>
                        </div>
                        <div class="musicbrainz-apply-row">
                          <div class="button" @click="applyMusicBrainzSuggestion">
                            {{ t('metadata.musicbrainzApplySelection') }}
                          </div>
                          <div v-if="musicBrainzState.applyMessage" class="success-text">
                            {{ musicBrainzState.applyMessage }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="section">
                  <div class="section-title">{{ t('metadata.basicInfo') }}</div>
                  <div class="form-grid">
                    <label>{{ t('metadata.title') }}</label>
                    <input v-model="form.title" :disabled="submitting" />

                    <label>{{ t('metadata.artist') }}</label>
                    <input v-model="form.artist" :disabled="submitting" />

                    <label>{{ t('metadata.genre') }}</label>
                    <input v-model="form.genre" :disabled="submitting" />

                    <label>{{ t('metadata.year') }}</label>
                    <input v-model="form.year" :disabled="submitting" />
                  </div>
                </div>

                <div class="section">
                  <div class="section-title">{{ t('metadata.albumInfo') }}</div>
                  <div class="form-grid">
                    <label>{{ t('metadata.album') }}</label>
                    <input v-model="form.album" :disabled="submitting" />

                    <label>{{ t('metadata.albumArtist') }}</label>
                    <input v-model="form.albumArtist" :disabled="submitting" />

                    <label>{{ t('metadata.trackNo') }}</label>
                    <input v-model="form.trackNo" :disabled="submitting" />

                    <label>{{ t('metadata.trackTotal') }}</label>
                    <input v-model="form.trackTotal" :disabled="submitting" />

                    <label>{{ t('metadata.discNo') }}</label>
                    <input v-model="form.discNo" :disabled="submitting" />

                    <label>{{ t('metadata.discTotal') }}</label>
                    <input v-model="form.discTotal" :disabled="submitting" />
                  </div>
                </div>

                <div class="section">
                  <div class="section-title">{{ t('metadata.peopleInfo') }}</div>
                  <div class="form-grid">
                    <label>{{ t('metadata.composer') }}</label>
                    <input v-model="form.composer" :disabled="submitting" />

                    <label>{{ t('metadata.lyricist') }}</label>
                    <input v-model="form.lyricist" :disabled="submitting" />

                    <label>{{ t('metadata.label') }}</label>
                    <input v-model="form.label" :disabled="submitting" />

                    <label>{{ t('metadata.isrc') }}</label>
                    <input v-model="form.isrc" :disabled="submitting" />
                  </div>
                </div>

                <div class="section">
                  <div class="section-title">{{ t('metadata.otherInfo') }}</div>
                  <div class="form-grid">
                    <label>{{ t('metadata.comment') }}</label>
                    <textarea v-model="form.comment" rows="2" :disabled="submitting"></textarea>

                    <label>{{ t('metadata.lyrics') }}</label>
                    <textarea v-model="form.lyrics" rows="4" :disabled="submitting"></textarea>
                  </div>
                </div>

                <div class="section">
                  <div class="section-title">{{ t('metadata.cover') }}</div>
                  <div class="cover-row">
                    <div class="cover-preview">
                      <img v-if="coverDataUrl" :src="coverDataUrl" alt="cover" />
                      <div v-else class="cover-placeholder">{{ t('metadata.noCover') }}</div>
                    </div>
                    <div class="cover-actions">
                      <div
                        class="button"
                        :class="{ disabled: submitting }"
                        @click="submitting ? null : onFileButtonClick()"
                      >
                        {{ t('metadata.chooseCover') }}
                      </div>
                      <div
                        class="button"
                        :class="{ disabled: isRemoveDisabled }"
                        @click="isRemoveDisabled ? null : onRemoveCover()"
                      >
                        {{ t('metadata.removeCover') }}
                      </div>
                      <div
                        v-if="showRestoreButton"
                        class="button"
                        :class="{ disabled: isRestoreDisabled }"
                        @click="isRestoreDisabled ? null : onRestoreCover()"
                      >
                        {{ t('metadata.restoreCover') }}
                      </div>
                    </div>
                  </div>
                  <div class="cover-hint">{{ t('metadata.coverHint') }}</div>
                </div>
              </div>

              <div v-if="errorMessage" class="error-text">{{ errorMessage }}</div>
            </div>
          </OverlayScrollbarsComponent>
        </div>
      </div>

      <div class="footer">
        <div
          class="button"
          :class="{ disabled: loading || submitting }"
          @click="loading || submitting ? null : onConfirm()"
        >
          {{ submitting ? t('metadata.saving') : t('common.save') }} (E)
        </div>
        <div
          class="button"
          :class="{ disabled: submitting }"
          @click="submitting ? null : onCancel()"
        >
          {{ t('common.cancel') }} (Esc)
        </div>
      </div>
    </div>

    <input
      ref="fileInputRef"
      class="hidden-input"
      type="file"
      accept="image/*"
      @change="onCoverSelected"
    />
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 520px;
  height: 520px;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.top-block {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.dialog-title {
  text-align: center;
  height: 30px;
  line-height: 30px;
  font-size: 14px;
  font-weight: bold;
  background-color: var(--bg);
  border-bottom: 1px solid var(--border);
}

.body {
  flex: 1;
  min-height: 0;
}

.content {
  padding: 18px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  font-size: 14px;
}

.path-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary, #888);
}

.filename-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.filename-extension {
  font-size: 14px;
  color: var(--text-secondary, #888);
  min-width: 60px;
}

.filename-input-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.myInput {
  width: 100%;
  min-height: 26px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  padding: 4px 8px;
  border-radius: 3px;
  font-size: 14px;
  box-sizing: border-box;
}

.myInput:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
}

.myInputRedBorder {
  border: 1px solid #be1100;
  box-shadow: 0 0 0 2px rgba(190, 17, 0, 0.2);
}

.myInputHint {
  margin-top: 4px;
  div {
    width: 100%;
    min-height: 25px;
    line-height: 25px;
    background-color: #5a1d1d;
    border: 1px solid #be1100;
    color: #ffffff;
    font-size: 12px;
    padding: 0 8px;
    border-radius: 4px;
    box-sizing: border-box;
  }
}

.is-flashing-error {
  animation: flash-error 0.5s linear infinite;
}

@keyframes flash-error {
  0%,
  100% {
    box-shadow: 0 0 0 1px transparent;
  }

  33.33%,
  66.66% {
    box-shadow: inset 0 0 0 1px #be1100;
  }
}

.path-value {
  background-color: var(--bg);
  padding: 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  word-break: break-all;
}

.loading {
  font-size: 14px;
}

.error-block {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--accent);
}

.error-block .text-button {
  padding: 0 12px;
  min-width: 80px;
}

.form-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-title {
  font-weight: bold;
  font-size: 14px;
}

.form-grid {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 8px 12px;
  align-items: center;
}

.form-grid label {
  font-size: 13px;
  color: var(--text-secondary, #aaa);
}

.form-grid input,
.form-grid textarea {
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

  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
  }
}

.form-grid textarea {
  resize: vertical;
  min-height: 60px;
}

.filename-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.filename-extension {
  font-size: 14px;
  color: var(--text-secondary, #888);
  min-width: 60px;
}

.cover-row {
  display: flex;
  gap: 16px;
  align-items: center;
}

.cover-preview {
  width: 140px;
  height: 140px;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--bg);
}

.cover-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.cover-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.error-text {
  margin-top: 8px;
  color: var(--accent);
  font-size: 13px;
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 12px 18px 18px;
  border-top: 1px solid var(--border);
  background-color: var(--bg);
}

.hidden-input {
  display: none;
}

.button.disabled {
  opacity: 0.6;
  pointer-events: none;
}

.cover-hint {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.musicbrainz-section {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  background-color: var(--bg);
  gap: 8px;
}

.musicbrainz-toggle-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.musicbrainz-toggle-actions {
  display: flex;
  gap: 8px;
}

.musicbrainz-hint {
  font-size: 12px;
  color: var(--text-secondary, #888);
  margin-top: 4px;
}

.musicbrainz-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}

.musicbrainz-query-grid {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 8px 12px;
  align-items: center;
}

.musicbrainz-duration {
  font-size: 13px;
  color: var(--text-secondary, #888);
}

.musicbrainz-panel-actions {
  display: flex;
  gap: 10px;
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

.result-title-row {
  display: flex;
  justify-content: space-between;
  font-weight: bold;
}

.result-score {
  font-size: 12px;
  color: var(--accent);
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

.musicbrainz-field-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 220px;
  overflow: auto;
}

.musicbrainz-field-grid label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.musicbrainz-field-grid label.disabled {
  opacity: 0.6;
}

.musicbrainz-field-grid .field-name {
  width: 120px;
}

.musicbrainz-field-grid .field-value {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.musicbrainz-apply-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.musicbrainz-empty,
.musicbrainz-loading {
  font-size: 13px;
  color: var(--text-secondary, #888);
}
</style>
