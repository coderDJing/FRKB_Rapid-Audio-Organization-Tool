import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import {
  MIXTAPE_DRAG_SESSION_MIME,
  MIXTAPE_DRAG_SESSION_TEXT_PREFIX,
  type MixtapeDragSessionPayload,
  type MixtapeDragSessionPreview
} from '@shared/mixtapeDragSession'
import type { MixtapeOpenPayload, MixtapeTrack } from '@renderer/composables/mixtape/types'

type TranslateFn = (key: string, values?: Record<string, unknown>) => string

type UseMixtapeMainWindowDropOptions = {
  payload: Ref<MixtapeOpenPayload>
  tracks: Ref<MixtapeTrack[]>
  selectedTrackId: Ref<string>
  loadMixtapeItems: (options?: { background?: boolean }) => Promise<void>
  scrollTimelineToEnd: () => void
  t: TranslateFn
}

type MixtapeAppendResult = {
  inserted?: number
  skippedNoBpm?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const normalizePreview = (value: unknown): MixtapeDragSessionPreview | null => {
  if (!isRecord(value)) return null
  const token = normalizeText(value.token)
  const itemCount = Number(value.itemCount)
  if (!token || !Number.isFinite(itemCount) || itemCount <= 0) return null
  return {
    token,
    sourceSongListUUID: normalizeText(value.sourceSongListUUID) || undefined,
    itemCount
  }
}

const normalizeSessionPayload = (value: unknown): MixtapeDragSessionPayload | null => {
  if (!isRecord(value)) return null
  const token = normalizeText(value.token)
  const rawItems = Array.isArray(value.items) ? value.items : []
  const items = rawItems.filter(
    (item): item is MixtapeDragSessionPayload['items'][number] =>
      isRecord(item) && !!normalizeText(item.filePath)
  )
  if (!token || !items.length) return null
  return {
    token,
    sourceSongListUUID: normalizeText(value.sourceSongListUUID) || undefined,
    items
  }
}

const parseJsonRecord = (value: string): Record<string, unknown> | null => {
  if (!value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

const readPreviewFromTransfer = (
  dataTransfer: DataTransfer | null
): MixtapeDragSessionPreview | null => {
  if (!dataTransfer) return null
  let raw = ''
  try {
    raw = dataTransfer.getData(MIXTAPE_DRAG_SESSION_MIME)
  } catch {
    raw = ''
  }
  if (!raw) return null
  return normalizePreview(parseJsonRecord(raw))
}

const readTokenFromTransfer = (dataTransfer: DataTransfer | null): string => {
  const preview = readPreviewFromTransfer(dataTransfer)
  if (preview?.token) return preview.token
  let text = ''
  try {
    text = dataTransfer?.getData('text/plain') || ''
  } catch {
    text = ''
  }
  return text.startsWith(MIXTAPE_DRAG_SESSION_TEXT_PREFIX)
    ? text.slice(MIXTAPE_DRAG_SESSION_TEXT_PREFIX.length).trim()
    : ''
}

export const useMixtapeMainWindowDrop = ({
  payload,
  tracks,
  selectedTrackId,
  loadMixtapeItems,
  scrollTimelineToEnd,
  t
}: UseMixtapeMainWindowDropOptions) => {
  const dropActive = ref(false)
  const dropBusy = ref(false)
  const dropItemCount = ref(0)
  const activeToken = ref('')
  const noticeTitleKey = ref('')
  const noticeHintKey = ref('')
  const noticeCount = ref(0)
  let dragEnterDepth = 0
  let latestPeekToken = 0
  let latestPeekAtMs = 0
  let noticeTimer: ReturnType<typeof setTimeout> | null = null

  const clearNoticeTimer = () => {
    if (!noticeTimer) return
    clearTimeout(noticeTimer)
    noticeTimer = null
  }

  const clearDropCandidate = () => {
    dropActive.value = false
    activeToken.value = ''
    dropItemCount.value = 0
  }

  const showNotice = (titleKey: string, hintKey: string, count = 0) => {
    clearNoticeTimer()
    noticeTitleKey.value = titleKey
    noticeHintKey.value = hintKey
    noticeCount.value = count
    noticeTimer = setTimeout(() => {
      noticeTitleKey.value = ''
      noticeHintKey.value = ''
      noticeCount.value = 0
      noticeTimer = null
    }, 1800)
  }

  const applyPreview = (preview: MixtapeDragSessionPreview | null) => {
    if (!preview) return
    activeToken.value = preview.token
    dropItemCount.value = preview.itemCount
    dropActive.value = true
  }

  const peekLatestSession = async () => {
    const now = Date.now()
    if (now - latestPeekAtMs < 150) return
    latestPeekAtMs = now
    const requestToken = ++latestPeekToken
    try {
      const result = await window.electron.ipcRenderer.invoke('mixtape-drag-session:peek-latest')
      if (requestToken !== latestPeekToken) return
      applyPreview(normalizePreview(result))
    } catch {}
  }

  const prepareDropCandidate = (event: DragEvent) => {
    const preview = readPreviewFromTransfer(event.dataTransfer)
    if (preview) {
      applyPreview(preview)
      return
    }
    if (!dropActive.value) {
      void peekLatestSession()
    }
  }

  const consumeDropSession = async (
    event: DragEvent
  ): Promise<MixtapeDragSessionPayload | null> => {
    const token = readTokenFromTransfer(event.dataTransfer) || activeToken.value
    if (token) {
      const result = await window.electron.ipcRenderer.invoke('mixtape-drag-session:consume', token)
      const session = normalizeSessionPayload(result)
      if (session) return session
    }
    const latest = await window.electron.ipcRenderer.invoke('mixtape-drag-session:consume-latest')
    return normalizeSessionPayload(latest)
  }

  const isCurrentMixtapeSelfDrop = (session: MixtapeDragSessionPayload, playlistId: string) => {
    const sourceSongListUUID = normalizeText(session.sourceSongListUUID)
    if (!sourceSongListUUID || sourceSongListUUID !== playlistId) return false
    return session.items.some((item) => !!normalizeText(item.sourceItemId))
  }

  const handleMixtapeSongDragEnter = (event: DragEvent) => {
    if (!normalizeText(payload.value.playlistId)) return
    const current = event.currentTarget as HTMLElement | null
    const related = event.relatedTarget as Node | null
    if (current && related && current.contains(related)) return
    dragEnterDepth += 1
    event.preventDefault()
    event.stopPropagation()
    prepareDropCandidate(event)
  }

  const handleMixtapeSongDragOver = (event: DragEvent) => {
    if (!normalizeText(payload.value.playlistId)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = dropBusy.value ? 'none' : 'copy'
    }
    prepareDropCandidate(event)
  }

  const handleMixtapeSongDragLeave = (event: DragEvent) => {
    const current = event.currentTarget as HTMLElement | null
    const related = event.relatedTarget as Node | null
    if (current && related && current.contains(related)) return
    dragEnterDepth = Math.max(0, dragEnterDepth - 1)
    if (dragEnterDepth === 0 && !dropBusy.value) {
      clearDropCandidate()
    }
  }

  const handleMixtapeSongDrop = async (event: DragEvent) => {
    const playlistId = normalizeText(payload.value.playlistId)
    if (!playlistId || dropBusy.value) return
    event.preventDefault()
    event.stopPropagation()
    dragEnterDepth = 0
    const hadCandidate = dropActive.value || !!readTokenFromTransfer(event.dataTransfer)
    dropBusy.value = true
    try {
      const session = await consumeDropSession(event)
      clearDropCandidate()
      if (!session || !session.items.length) {
        if (hadCandidate) {
          showNotice('mixtape.dropFailedTitle', 'mixtape.dropFailedHint')
        }
        return
      }
      if (isCurrentMixtapeSelfDrop(session, playlistId)) {
        showNotice('mixtape.dropSelfTitle', 'mixtape.dropSelfHint', session.items.length)
        return
      }
      const previousTrackCount = tracks.value.length
      const result = (await window.electron.ipcRenderer.invoke('mixtape:append', {
        playlistId,
        items: session.items
      })) as MixtapeAppendResult
      const inserted = Math.max(0, Number(result?.inserted || 0))
      const skippedNoBpm = Math.max(0, Number(result?.skippedNoBpm || 0))
      if (inserted <= 0 && skippedNoBpm > 0) {
        showNotice('mixtape.dropNoBpmBlockedTitle', 'mixtape.dropNoBpmBlockedHint', skippedNoBpm)
        return
      }
      if (inserted <= 0) {
        showNotice('mixtape.dropFailedTitle', 'mixtape.dropFailedHint')
        return
      }
      await loadMixtapeItems({ background: true })
      const selectedTrack = tracks.value[previousTrackCount] || tracks.value.at(-1)
      if (selectedTrack?.id) {
        selectedTrackId.value = selectedTrack.id
      }
      scrollTimelineToEnd()
      showNotice(
        'mixtape.dropAddedTitle',
        skippedNoBpm > 0 ? 'mixtape.dropNoBpmSkippedHint' : 'mixtape.dropAddedHint',
        inserted
      )
    } catch {
      showNotice('mixtape.dropFailedTitle', 'mixtape.dropFailedHint')
    } finally {
      dropBusy.value = false
    }
  }

  onBeforeUnmount(() => {
    clearNoticeTimer()
  })

  const mixtapeDropOverlayVisible = computed(
    () => dropActive.value || dropBusy.value || !!noticeTitleKey.value
  )
  const mixtapeDropOverlayTitle = computed(() => {
    if (dropBusy.value) return t('mixtape.dropAddingTitle')
    if (noticeTitleKey.value) return t(noticeTitleKey.value, { count: noticeCount.value })
    return t('mixtape.dropReadyTitle')
  })
  const mixtapeDropOverlayHint = computed(() => {
    if (dropBusy.value) return t('mixtape.dropAddingHint')
    if (noticeHintKey.value) return t(noticeHintKey.value, { count: noticeCount.value })
    return t('mixtape.dropReadyHint', { count: dropItemCount.value || 1 })
  })

  return {
    mixtapeDropOverlayVisible,
    mixtapeDropOverlayTitle,
    mixtapeDropOverlayHint,
    dropBusy,
    handleMixtapeSongDragEnter,
    handleMixtapeSongDragOver,
    handleMixtapeSongDragLeave,
    handleMixtapeSongDrop
  }
}
