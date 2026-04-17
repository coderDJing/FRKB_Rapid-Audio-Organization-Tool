import { is } from '@electron-toolkit/utils'
import {
  getCuratedArtistLibrarySnapshot,
  replaceCuratedArtistLibrary
} from './curatedArtistLibrary'
import { log } from './log'

type LimitedFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => Promise<Response>

type SyncConfig = {
  baseUrl: string
  apiSecretKey: string
  userKey: string
}

type CuratedArtistSyncResponse = {
  success?: boolean
  error?: string
  message?: string
}

type CuratedArtistSyncError = Error & {
  response?: unknown
}

const CURATED_ARTIST_PREFIX = '/frkbapi/v1/curated-artist-sync'

export function getCuratedArtistSyncErrorPayload(error: unknown): unknown {
  return typeof error === 'object' && error ? (error as CuratedArtistSyncError).response : undefined
}

export function isCuratedArtistSyncUnsupportedServer(payload: unknown): boolean {
  const body = payload as CuratedArtistSyncResponse | null
  const errorCode = String(body?.error || '').toUpperCase()
  const message = String(body?.message || '')
  return (
    errorCode === 'API_ROUTE_NOT_FOUND' ||
    message.includes('/curated-artist-sync/') ||
    message.includes('API路由不存在')
  )
}

export async function syncCuratedArtistCloudSnapshot(params: {
  config: SyncConfig
  limitedFetch: LimitedFetch
}) {
  const { config, limitedFetch } = params
  const localSnapshot = getCuratedArtistLibrarySnapshot()
  const payload = {
    userKey: config.userKey,
    artists: localSnapshot.items,
    count: localSnapshot.count,
    hash: localSnapshot.hash
  }

  if (is.dev) {
    log.info('[cloudSync] /curated-artist-sync request', {
      url: `${config.baseUrl}${CURATED_ARTIST_PREFIX}/sync`,
      headers: {
        Authorization: `Bearer ${config.apiSecretKey}`,
        'Content-Type': 'application/json'
      },
      body: payload
    })
  }

  const response = await limitedFetch(`${config.baseUrl}${CURATED_ARTIST_PREFIX}/sync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiSecretKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  const json = await response.json()

  if (is.dev) {
    log.info('[cloudSync] /curated-artist-sync response', { status: response.status, json })
  }

  if (!json?.success) {
    const error = new Error('curated artist sync failed') as CuratedArtistSyncError
    error.response = json
    throw error
  }

  const mergedSnapshot = replaceCuratedArtistLibrary(json?.mergedSnapshot?.items || [])
  return {
    localSnapshot,
    mergedSnapshot,
    response: json
  }
}
