import { ipcMain } from 'electron'
import {
  type MixtapeDragSessionItem,
  type MixtapeDragSessionPayload,
  type MixtapeDragSessionPreview
} from '../../shared/mixtapeDragSession'

type StoredMixtapeDragSession = MixtapeDragSessionPayload & {
  createdAtMs: number
}

const sessions = new Map<string, StoredMixtapeDragSession>()
let latestToken = ''

const SESSION_TTL_MS = 60_000
const MAX_SESSION_COUNT = 32

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const normalizeNullableText = (value: unknown): string | null => {
  const text = normalizeText(value)
  return text || null
}

const normalizeInfo = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? { ...value } : null

const normalizeItem = (value: unknown): MixtapeDragSessionItem | null => {
  if (!isRecord(value)) return null
  const filePath = normalizeText(value.filePath)
  if (!filePath) return null
  return {
    filePath,
    originPlaylistUuid: normalizeNullableText(value.originPlaylistUuid),
    originPathSnapshot: normalizeNullableText(value.originPathSnapshot),
    info: normalizeInfo(value.info),
    sourcePlaylistId: normalizeNullableText(value.sourcePlaylistId),
    sourceItemId: normalizeNullableText(value.sourceItemId)
  }
}

const pruneExpiredSessions = () => {
  const now = Date.now()
  for (const [token, session] of sessions.entries()) {
    if (now - session.createdAtMs > SESSION_TTL_MS) {
      sessions.delete(token)
      if (latestToken === token) latestToken = ''
    }
  }
  while (sessions.size > MAX_SESSION_COUNT) {
    const oldest = sessions.keys().next().value
    if (!oldest) break
    sessions.delete(oldest)
    if (latestToken === oldest) latestToken = ''
  }
}

const normalizeSessionPayload = (value: unknown): StoredMixtapeDragSession | null => {
  if (!isRecord(value)) return null
  const token = normalizeText(value.token)
  if (!token) return null
  const items = Array.isArray(value.items) ? value.items.map(normalizeItem).filter(Boolean) : []
  if (!items.length) return null
  return {
    token,
    sourceSongListUUID: normalizeText(value.sourceSongListUUID) || undefined,
    items: items as MixtapeDragSessionItem[],
    createdAtMs: Date.now()
  }
}

const toPreview = (session: StoredMixtapeDragSession): MixtapeDragSessionPreview => ({
  token: session.token,
  sourceSongListUUID: session.sourceSongListUUID,
  itemCount: session.items.length
})

const peekLatestSession = (): MixtapeDragSessionPreview | null => {
  pruneExpiredSessions()
  if (!latestToken) return null
  const session = sessions.get(latestToken)
  return session ? toPreview(session) : null
}

const consumeSession = (token: unknown): MixtapeDragSessionPayload | null => {
  pruneExpiredSessions()
  const normalizedToken = normalizeText(token)
  if (!normalizedToken) return null
  const session = sessions.get(normalizedToken)
  if (!session) return null
  sessions.delete(normalizedToken)
  if (latestToken === normalizedToken) latestToken = ''
  return {
    token: session.token,
    sourceSongListUUID: session.sourceSongListUUID,
    items: session.items
  }
}

export function registerMixtapeDragSessionHandlers() {
  ipcMain.on('mixtape-drag-session:create', (_event, payload: unknown) => {
    const session = normalizeSessionPayload(payload)
    if (!session) return
    pruneExpiredSessions()
    sessions.set(session.token, session)
    latestToken = session.token
  })

  ipcMain.on('mixtape-drag-session:cancel', (_event, token: unknown) => {
    const normalizedToken = normalizeText(token)
    if (!normalizedToken) return
    sessions.delete(normalizedToken)
    if (latestToken === normalizedToken) latestToken = ''
  })

  ipcMain.handle('mixtape-drag-session:peek-latest', () => {
    return peekLatestSession()
  })

  ipcMain.handle('mixtape-drag-session:consume', (_event, token: unknown) => {
    return consumeSession(token)
  })

  ipcMain.handle('mixtape-drag-session:consume-latest', () => {
    return consumeSession(latestToken)
  })
}
