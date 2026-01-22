import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { v4 as uuidV4 } from 'uuid'
import hotkeys from 'hotkeys-js'
import utils from '@renderer/utils/utils'
import { t } from '@renderer/utils/translate'
import confirm from '@renderer/components/confirmDialog'
import showMusicBrainzDialog, { MusicBrainzDialogInitialQuery } from '../musicBrainzDialog'
import type {
  ITrackMetadataDetail,
  ITrackMetadataUpdatePayload,
  IMusicBrainzApplyPayload
} from 'src/types/globals'

const WAV_COVER_HINT_KEY = 'FRKB_HIDE_WAV_COVER_HINT'
const invalidFileNameRegex = /[<>:"/\\|?*\u0000-\u001F]/

interface DialogProps {
  filePath: string
  confirmCallback: (payload?: any) => void
  cancelCallback: () => void
}

export function useEditMetadataDialog(props: DialogProps) {
  const uuid = uuidV4()

  const loading = ref(true)
  const loadError = ref('')
  const submitting = ref(false)
  const errorMessage = ref('')

  const currentFilePath = ref(props.filePath)
  const fileName = ref('')
  const originalFileName = ref('')
  const fileExtension = ref('')
  const fileNameError = ref('')

  const metadataDetail = ref<ITrackMetadataDetail | null>(null)
  const coverDataUrl = ref<string | null>(null)
  const originalCoverDataUrl = ref<string | null>(null)

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

  const isWavFile = computed(() => fileExtension.value.toLowerCase() === '.wav')

  const fileInputRef = ref<HTMLInputElement | null>(null)
  const isRemoveDisabled = computed(() => submitting.value || !coverDataUrl.value)
  const showRestoreButton = computed(() => !!originalCoverDataUrl.value)
  const isRestoreDisabled = computed(
    () =>
      submitting.value ||
      !originalCoverDataUrl.value ||
      coverDataUrl.value === originalCoverDataUrl.value
  )

  const flashArea = ref('')
  let flashTimer: any = null
  let flashCount = 0
  const musicBrainzDialogOpening = ref(false)
  const appliedMusicBrainzData = ref(false)

  async function showMetadataErrorDialog(message: string) {
    errorMessage.value = message
    await confirm({
      title: t('common.error'),
      content: [message],
      confirmShow: false,
      innerWidth: 420,
      canCopyText: true,
      textAlign: 'left'
    })
  }

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
    appliedMusicBrainzData.value = true
    if (payload.title !== undefined) form.title = payload.title
    if (payload.artist !== undefined) form.artist = payload.artist
    if (payload.album !== undefined) form.album = payload.album
    if (payload.albumArtist !== undefined) form.albumArtist = payload.albumArtist
    if (payload.year !== undefined) form.year = payload.year
    if (payload.genre !== undefined) form.genre = payload.genre
    if (payload.label !== undefined) form.label = payload.label
    if (payload.isrc !== undefined) form.isrc = payload.isrc
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
    } catch {
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

  function normalizeText(value: string | undefined | null): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }

  function parsePositiveInt(value: string | undefined | null, errorKey: string) {
    if (typeof value !== 'string') return undefined
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
      coverDataUrl: !isWavFile.value ? coverDataUrl.value : undefined,
      markAsAutoFilled: appliedMusicBrainzData.value || undefined
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
        errorCode?: string
        errorDetail?: string
      }
      if (!response || response.success !== true || !response.songInfo || !response.detail) {
        const code = response?.errorCode || response?.message
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
        if (code === 'FFMPEG_METADATA_FAILED') {
          const detail = response?.errorDetail?.trim()
          const message = detail
            ? t('metadata.ffmpegFailedWithReason', { reason: detail })
            : t('metadata.ffmpegFailed')
          await showMetadataErrorDialog(message)
          submitting.value = false
          return
        }
        const fallbackDetail = response?.errorDetail?.trim() || response?.message?.trim() || ''
        const fallback = fallbackDetail !== '' ? fallbackDetail : t('common.error')
        await showMetadataErrorDialog(t('metadata.saveFailed', { message: fallback }))
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
      await maybeShowWavCoverHint()
    } catch (err: any) {
      const code = err?.errorCode || err?.message
      if (code === 'INVALID_FILE_NAME') {
        fileNameError.value = t('metadata.fileNameInvalid')
        flashFileNameInput()
      } else if (code === 'FILE_NAME_EXISTS') {
        fileNameError.value = t('metadata.fileNameExists')
        flashFileNameInput()
      } else if (code === 'FFMPEG_METADATA_FAILED') {
        const detail = err?.errorDetail?.trim()
        const message = detail
          ? t('metadata.ffmpegFailedWithReason', { reason: detail })
          : t('metadata.ffmpegFailed')
        await showMetadataErrorDialog(message)
      } else {
        const fallback = code && String(code).trim() !== '' ? code : t('common.error')
        await showMetadataErrorDialog(t('metadata.saveFailed', { message: fallback }))
      }
      submitting.value = false
    }
  }

  function onCancel() {
    if (submitting.value) return
    props.cancelCallback()
  }

  function onRemoveCover() {
    if (isRemoveDisabled.value || isWavFile.value) {
      coverDataUrl.value = null
      return
    }
    coverDataUrl.value = null
  }

  async function maybeShowWavCoverHint() {
    if (!isWavFile.value) return
    try {
      if (localStorage.getItem(WAV_COVER_HINT_KEY) === '1') return
    } catch {}
    const result = await confirm({
      title: t('metadata.cover'),
      content: [t('metadata.coverHintWav')],
      confirmShow: true,
      confirmText: t('metadata.coverHintDontAsk'),
      cancelText: t('common.close'),
      textAlign: 'left',
      innerWidth: 420,
      canCopyText: true
    })
    if (result === 'confirm') {
      try {
        localStorage.setItem(WAV_COVER_HINT_KEY, '1')
      } catch {}
    }
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

  return {
    loading,
    loadError,
    submitting,
    errorMessage,
    currentFilePath,
    fileName,
    fileExtension,
    fileNameError,
    form,
    isWavFile,
    metadataDetail,
    coverDataUrl,
    originalCoverDataUrl,
    fileInputRef,
    isRemoveDisabled,
    showRestoreButton,
    isRestoreDisabled,
    flashArea,
    musicBrainzDialogOpening,
    onFileNameInput,
    onOpenMusicBrainzDialog,
    loadMetadata,
    onFileButtonClick,
    onConfirm,
    onCancel,
    onRemoveCover,
    onRestoreCover,
    onCoverSelected
  }
}
