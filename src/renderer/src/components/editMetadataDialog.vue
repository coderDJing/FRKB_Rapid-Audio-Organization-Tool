<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue'
import { t } from '@renderer/utils/translate'
import hotkeys from 'hotkeys-js'
import utils from '@renderer/utils/utils'
import { v4 as uuidV4 } from 'uuid'
import type {
  ITrackMetadataDetail,
  ITrackMetadataUpdatePayload,
  IMusicBrainzApplyPayload
} from 'src/types/globals'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import showMusicBrainzDialog, { MusicBrainzDialogInitialQuery } from './musicBrainzDialog'

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

const musicBrainzDialogOpening = ref(false)

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

function buildMusicBrainzInitialQuery(): MusicBrainzDialogInitialQuery {
  const detail = metadataDetail.value
  return {
    title: form.title || detail?.title || undefined,
    artist: form.artist || detail?.artist || undefined,
    album: form.album || detail?.album || undefined,
    durationSeconds: detail?.durationSeconds,
    isrc: form.isrc || detail?.isrc || undefined
  }
}

function applyMusicBrainzPayload(payload: IMusicBrainzApplyPayload) {
  if (payload.title !== undefined) {
    form.title = payload.title
  }
  if (payload.artist !== undefined) {
    form.artist = payload.artist
  }
  if (payload.album !== undefined) {
    form.album = payload.album
  }
  if (payload.albumArtist !== undefined) {
    form.albumArtist = payload.albumArtist
  }
  if (payload.year !== undefined) {
    form.year = payload.year
  }
  if (payload.genre !== undefined) {
    form.genre = payload.genre
  }
  if (payload.label !== undefined) {
    form.label = payload.label
  }
  if (payload.isrc !== undefined) {
    form.isrc = payload.isrc
  }
  if (payload.trackNo !== undefined) {
    form.trackNo = payload.trackNo === null ? '' : String(payload.trackNo)
  }
  if (payload.trackTotal !== undefined) {
    form.trackTotal = payload.trackTotal === null ? '' : String(payload.trackTotal)
  }
  if (payload.discNo !== undefined) {
    form.discNo = payload.discNo === null ? '' : String(payload.discNo)
  }
  if (payload.discTotal !== undefined) {
    form.discTotal = payload.discTotal === null ? '' : String(payload.discTotal)
  }
  if (payload.coverDataUrl !== undefined) {
    coverDataUrl.value = payload.coverDataUrl ?? null
  }
}

async function onOpenMusicBrainzDialog() {
  if (loading.value || submitting.value || musicBrainzDialogOpening.value) return
  musicBrainzDialogOpening.value = true
  try {
    const result = await showMusicBrainzDialog({
      filePath: currentFilePath.value,
      initialQuery: buildMusicBrainzInitialQuery()
    })
    if (result !== 'cancel') {
      applyMusicBrainzPayload(result.payload)
    }
  } finally {
    musicBrainzDialogOpening.value = false
  }
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
                <div class="section">
                  <div class="section-title">{{ t('metadata.musicbrainzTitle') }}</div>
                  <div class="musicbrainz-launch-row">
                    <div class="musicbrainz-hint">{{ t('metadata.musicbrainzHint') }}</div>
                    <div
                      class="button"
                      :class="{
                        disabled:
                          loading || submitting || musicBrainzDialogOpening || !metadataDetail
                      }"
                      @click="
                        loading || submitting || musicBrainzDialogOpening || !metadataDetail
                          ? null
                          : onOpenMusicBrainzDialog()
                      "
                    >
                      {{ t('metadata.musicbrainzOpenDialog') }}
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

.musicbrainz-launch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.musicbrainz-hint {
  font-size: 12px;
  color: var(--text-secondary, #888);
  flex: 1;
}
</style>
