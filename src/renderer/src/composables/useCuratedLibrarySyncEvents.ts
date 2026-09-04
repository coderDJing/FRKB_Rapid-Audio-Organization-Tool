import emitter from '@renderer/utils/mitt'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import { continueCuratedLibrarySyncUi } from '@renderer/composables/runCuratedLibrarySyncUi'
import { RECYCLE_BIN_UUID } from '@shared/recycleBin'
import type {
  CuratedLibrarySyncListFileChange,
  CuratedLibrarySyncNotice,
  CuratedLibrarySyncPlaylistsChangedPayload,
  CuratedLibrarySyncStartResult
} from '../../../shared/curatedLibrarySync'

const isCuratedLibrarySyncNotice = (value: unknown): value is CuratedLibrarySyncNotice => {
  if (!value || typeof value !== 'object') return false
  if (!('kind' in value) || !('conflictCount' in value) || !('failureCount' in value)) return false
  return (
    (value.kind === 'conflicts' || value.kind === 'failures') &&
    typeof value.conflictCount === 'number' &&
    typeof value.failureCount === 'number'
  )
}

const isJoinPromptResult = (
  value: unknown
): value is Extract<
  CuratedLibrarySyncStartResult,
  { status: 'needs_join_choice' | 'needs_overwrite_cloud_confirm' }
> => {
  if (!value || typeof value !== 'object' || !('status' in value)) return false
  const status = (value as { status?: unknown }).status
  return status === 'needs_join_choice' || status === 'needs_overwrite_cloud_confirm'
}

const isListFileChange = (value: unknown): value is CuratedLibrarySyncListFileChange => {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  return (
    typeof rec.listUUID === 'string' &&
    rec.listUUID.length > 0 &&
    typeof rec.absPath === 'string' &&
    rec.absPath.length > 0 &&
    typeof rec.libraryPath === 'string' &&
    rec.libraryPath.length > 0
  )
}

const parsePlaylistsChangedPayload = (
  payload: unknown
): CuratedLibrarySyncPlaylistsChangedPayload | null => {
  if (!payload || typeof payload !== 'object') return null
  const rec = payload as Record<string, unknown>
  const uuids = Array.isArray(rec.uuids)
    ? rec.uuids.filter((uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0)
    : []
  const removed = Array.isArray(rec.removed) ? rec.removed.filter(isListFileChange) : []
  const added = Array.isArray(rec.added) ? rec.added.filter(isListFileChange) : []
  const updated = Array.isArray(rec.updated) ? rec.updated.filter(isListFileChange) : []
  if (uuids.length === 0 && removed.length === 0 && added.length === 0 && updated.length === 0) {
    return null
  }
  return { uuids, removed, added, updated }
}

const groupByListUuid = (items: CuratedLibrarySyncListFileChange[]) => {
  const groups = new Map<string, CuratedLibrarySyncListFileChange[]>()
  for (const item of items) {
    const list = groups.get(item.listUUID) || []
    list.push(item)
    groups.set(item.listUUID, list)
  }
  return groups
}

const toLiteSongInfo = (item: CuratedLibrarySyncListFileChange) => {
  const normalized = item.absPath.replace(/\\/g, '/')
  const fileName = normalized.split('/').pop() || item.absPath
  const dot = fileName.lastIndexOf('.')
  const fileFormat = dot >= 0 ? fileName.slice(dot + 1).toUpperCase() : ''
  const trackNumber =
    typeof item.trackNumber === 'number' && item.trackNumber > 0 ? item.trackNumber : undefined
  const addedAtMs =
    typeof item.addedAtMs === 'number' && Number.isFinite(item.addedAtMs)
      ? item.addedAtMs
      : undefined
  return {
    filePath: item.absPath,
    fileName,
    fileFormat,
    cover: null,
    title: fileName,
    artist: undefined,
    album: undefined,
    duration: '',
    genre: undefined,
    label: undefined,
    bitrate: undefined,
    container: fileFormat || undefined,
    playlistTrackNumber: trackNumber,
    addedAtMs
  }
}

export function useCuratedLibrarySyncEvents() {
  let noticeOpen = false
  let joinPromptOpen = false

  const handleCuratedLibrarySyncNotice = async (_e: unknown, payload: unknown) => {
    if (noticeOpen || !isCuratedLibrarySyncNotice(payload)) return
    noticeOpen = true
    try {
      const lines: string[] = []
      if (payload.conflictCount > 0) {
        lines.push(t('cloudSync.curatedLibrary.noticeConflicts', { count: payload.conflictCount }))
      }
      if (payload.failureCount > 0) {
        lines.push(t('cloudSync.curatedLibrary.noticeFailures', { count: payload.failureCount }))
      }
      if (lines.length === 0) return
      lines.push(t('cloudSync.curatedLibrary.openSettingsHint'))
      await confirm({
        title:
          payload.kind === 'conflicts'
            ? t('cloudSync.curatedLibrary.noticeConflictsTitle')
            : t('cloudSync.curatedLibrary.noticeFailuresTitle'),
        content: lines,
        confirmShow: false
      })
    } finally {
      noticeOpen = false
    }
  }

  const handleCuratedLibraryJoinPrompt = async (payload: unknown) => {
    if (joinPromptOpen || !isJoinPromptResult(payload)) return
    joinPromptOpen = true
    try {
      await continueCuratedLibrarySyncUi(payload, { quietTerminal: true })
    } finally {
      joinPromptOpen = false
      try {
        await window.electron.ipcRenderer.invoke('curatedLibrarySync/clearPendingJoin')
      } catch {}
    }
  }

  const handleCuratedLibrarySyncNeedsJoin = (_e: unknown, payload: unknown) => {
    void handleCuratedLibraryJoinPrompt(payload)
  }

  const handleCuratedLibraryPlaylistsChanged = (_e: unknown, payload: unknown) => {
    const parsed = parsePlaylistsChangedPayload(payload)
    if (!parsed) return

    for (const [listUUID, items] of groupByListUuid(parsed.removed)) {
      if (listUUID === RECYCLE_BIN_UUID) continue
      try {
        emitter.emit('songsRemoved', {
          listUUID,
          paths: items.map((item) => item.absPath)
        })
      } catch {}
    }

    for (const [listUUID, items] of groupByListUuid(parsed.added)) {
      if (listUUID === RECYCLE_BIN_UUID) continue
      const restoreItems = items.map((item) => {
        const trackNumber =
          typeof item.trackNumber === 'number' && item.trackNumber > 0 ? item.trackNumber : 0
        return {
          song: toLiteSongInfo(item),
          index: trackNumber > 0 ? trackNumber - 1 : Number.MAX_SAFE_INTEGER
        }
      })
      try {
        emitter.emit('songsArea/optimistic-restore', { listUUID, items: restoreItems })
      } catch {}
    }

    for (const [listUUID, items] of groupByListUuid(parsed.updated)) {
      if (listUUID === RECYCLE_BIN_UUID) continue
      try {
        emitter.emit('songsArea/sync-fields', {
          listUUID,
          items: items.map((item) => ({
            absPath: item.absPath,
            trackNumber: item.trackNumber,
            addedAtMs: item.addedAtMs
          }))
        })
      } catch {}
    }

    if (parsed.uuids.length > 0) {
      try {
        emitter.emit('playlistContentChanged', { uuids: parsed.uuids })
      } catch {}
    }

    // 回收站列表本身很轻；正在看回收站时才整表刷新，正在看精选库歌单时绝不能整表重扫。
    if (parsed.uuids.includes(RECYCLE_BIN_UUID)) {
      try {
        emitter.emit('songsArea/reload-if-current', { uuid: RECYCLE_BIN_UUID })
      } catch {}
    }
  }

  const consumePendingCuratedLibraryJoin = async () => {
    try {
      const pending = await window.electron.ipcRenderer.invoke('curatedLibrarySync/getPendingJoin')
      await handleCuratedLibraryJoinPrompt(pending)
    } catch {}
  }

  return {
    handleCuratedLibrarySyncNotice,
    handleCuratedLibrarySyncNeedsJoin,
    handleCuratedLibraryPlaylistsChanged,
    consumePendingCuratedLibraryJoin
  }
}
