import path = require('path')
import mainWindow from '../window/mainWindow'
import { log } from '../log'
import {
  IMetadataAutoFillRequest,
  IMetadataAutoFillSummary,
  IMetadataAutoFillItemResult,
  IMusicBrainzMatch,
  IMusicBrainzSearchPayload,
  IMusicBrainzSuggestionResult,
  ITrackMetadataUpdatePayload
} from '../../types/globals'
import { readTrackMetadata, updateTrackMetadata } from './metadataEditor'
import { matchTrackWithAcoustId, cancelAcoustIdRequests } from './acoustId'
import {
  searchMusicBrainz,
  fetchMusicBrainzSuggestion,
  cancelMusicBrainzRequests
} from './musicBrainz'
import { findSongListRoot, clearSongListCaches } from './cacheMaintenance'
import store from '../store'

type ProgressEmitter = (
  titleKey: string,
  now: number,
  total: number,
  options?: { isInitial?: boolean; extras?: Record<string, any> }
) => void

function createProgressEmitter(
  progressId: string,
  baseExtras?: Record<string, any>
): ProgressEmitter {
  return (titleKey, now, total, options) => {
    if (!mainWindow.instance) return
    mainWindow.instance.webContents.send('progressSet', {
      id: progressId,
      titleKey,
      now,
      total,
      isInitial: !!options?.isInitial,
      ...(baseExtras || {}),
      ...(options?.extras || {})
    })
  }
}

function normalizeText(value?: string | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function buildSearchPayload(detail: {
  filePath: string
  title?: string
  artist?: string
  album?: string
  durationSeconds?: number
}): IMusicBrainzSearchPayload | null {
  const title = normalizeText(detail.title)
  const artist = normalizeText(detail.artist)
  const durationSeconds =
    typeof detail.durationSeconds === 'number' && detail.durationSeconds > 0
      ? detail.durationSeconds
      : undefined
  let album = normalizeText(detail.album)
  if (title || artist) {
    // 默认不附带专辑，除非标题和艺人都缺失
    album = undefined
  }
  if (!title && !artist && !album && !durationSeconds) return null
  return {
    filePath: detail.filePath,
    title,
    artist,
    album,
    durationSeconds
  }
}

function buildUpdatePayload(
  filePath: string,
  suggestion: IMusicBrainzSuggestionResult['suggestion']
): ITrackMetadataUpdatePayload | null {
  const payload: ITrackMetadataUpdatePayload = {
    filePath
  }
  const assignString = (key: keyof ITrackMetadataUpdatePayload, value?: string | null) => {
    const normalized = normalizeText(value ?? undefined)
    if (normalized !== undefined) {
      ;(payload as any)[key] = normalized
    }
  }
  assignString('title', suggestion.title)
  assignString('artist', suggestion.artist)
  assignString('album', suggestion.album)
  assignString('albumArtist', suggestion.albumArtist)
  assignString('year', suggestion.year)
  assignString('genre', suggestion.genre)
  assignString('label', suggestion.label)
  assignString('isrc', suggestion.isrc)
  if (typeof suggestion.trackNo === 'number') payload.trackNo = suggestion.trackNo
  if (typeof suggestion.trackTotal === 'number') payload.trackTotal = suggestion.trackTotal
  if (typeof suggestion.discNo === 'number') payload.discNo = suggestion.discNo
  if (typeof suggestion.discTotal === 'number') payload.discTotal = suggestion.discTotal

  if (suggestion.coverDataUrl) {
    payload.coverDataUrl = suggestion.coverDataUrl
  }

  const hasAnyField = Object.keys(payload).some((key) => key !== 'filePath')
  if (!hasAnyField) return null
  return payload
}

function summarizeErrorMessage(err: any): string {
  if (!err) return 'UNKNOWN'
  if (typeof err.message === 'string' && err.message.trim()) {
    return err.message.trim()
  }
  if (typeof err === 'string' && err.trim()) {
    return err.trim()
  }
  if (typeof err.code === 'string') return err.code
  return 'UNKNOWN'
}

const cancelTokens = new Map<string, { cancelled: boolean }>()

function createCancelToken(progressId: string) {
  const token = { cancelled: false }
  cancelTokens.set(progressId, token)
  return token
}

export function cancelMetadataAutoFill(progressId?: string) {
  if (!progressId) return
  const token = cancelTokens.get(progressId)
  if (token) token.cancelled = true
  // 终止在途请求以尽快落地取消
  cancelMusicBrainzRequests()
  cancelAcoustIdRequests()
}

export async function autoFillTrackMetadata(
  payload: IMetadataAutoFillRequest
): Promise<IMetadataAutoFillSummary> {
  const uniquePaths = Array.from(
    new Set(
      (payload?.filePaths || [])
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => path.resolve(p))
    )
  )
  const progressId = payload?.progressId || `metadata_auto_${Date.now()}`
  const cancelToken = createCancelToken(progressId)
  const progressExtras = {
    cancelable: true,
    cancelChannel: 'metadata:autoFill:cancel',
    cancelPayload: progressId
  }
  const pushProgress = createProgressEmitter(progressId, progressExtras)
  const summary: IMetadataAutoFillSummary = {
    total: uniquePaths.length,
    applied: 0,
    fingerprintApplied: 0,
    searchApplied: 0,
    noMatch: 0,
    skipped: 0,
    errors: 0,
    durationMs: 0,
    progressId,
    items: []
  }
  const startedAt = Date.now()
  let cancelled = false
  try {
    if (uniquePaths.length === 0) {
      pushProgress('metadata.autoFillProgressFinished', 1, 1, { isInitial: true })
      return summary
    }

    pushProgress('metadata.autoFillProgressPreparing', 0, uniquePaths.length, { isInitial: true })

    const configuredAcoustIdKey =
      typeof (store as any)?.settingConfig?.acoustIdClientKey === 'string'
        ? String((store as any).settingConfig.acoustIdClientKey).trim()
        : ''
    let fingerprintDisabledCode: string | null = configuredAcoustIdKey
      ? null
      : 'ACOUSTID_CLIENT_MISSING'
    const touchedSongListRoots = new Set<string>()

    for (let idx = 0; idx < uniquePaths.length; idx++) {
      if (cancelToken.cancelled) {
        cancelled = true
        break
      }
      const filePath = uniquePaths[idx]
      const item: IMetadataAutoFillItemResult = {
        filePath,
        displayName: path.basename(filePath),
        status: 'skipped'
      }
      summary.items.push(item)
      try {
        const detail = await readTrackMetadata(filePath)
        if (!detail) {
          item.status = 'error'
          item.messageCode = 'READ_FAILED'
          summary.errors++
          continue
        }
        item.displayName =
          normalizeText(detail.title) || normalizeText(detail.fileName) || item.displayName

        let match: IMusicBrainzMatch | null = null
        let method: 'fingerprint' | 'search' | undefined

        if (fingerprintDisabledCode === null) {
          try {
            const matches = await matchTrackWithAcoustId({
              filePath,
              durationSeconds: detail.durationSeconds
            })
            if (matches && matches.length > 0) {
              match = matches[0]
              method = 'fingerprint'
            }
          } catch (err: any) {
            const code = summarizeErrorMessage(err)
            if (
              code === 'ACOUSTID_CLIENT_MISSING' ||
              code === 'ACOUSTID_FPCALC_NOT_FOUND' ||
              code === 'ACOUSTID_CLIENT_INVALID'
            ) {
              fingerprintDisabledCode = code
            } else {
              log.warn('[metadata-auto] fingerprint match failed', { filePath, code })
            }
          }
        }

        if (!match) {
          const searchPayload = buildSearchPayload(detail)
          if (!searchPayload) {
            summary.skipped++
            item.status = 'skipped'
            item.messageCode = 'NO_QUERY'
            continue
          }
          try {
            const matches = await searchMusicBrainz(searchPayload)
            if (matches && matches.length > 0) {
              match = matches[0]
              method = 'search'
            }
          } catch (err: any) {
            log.error('[metadata-auto] musicbrainz search failed', {
              filePath,
              error: err?.message || err
            })
            summary.errors++
            item.status = 'error'
            item.messageCode = 'SEARCH_FAILED'
            item.messageDetail = summarizeErrorMessage(err)
            continue
          }
        }

        if (!match) {
          summary.noMatch++
          item.status = 'no-match'
          item.messageCode = 'NO_RESULT'
          continue
        }

        let suggestion: IMusicBrainzSuggestionResult | null = null
        try {
          suggestion = await fetchMusicBrainzSuggestion({
            recordingId: match.recordingId,
            releaseId: match.releaseId,
            allowFallback: true
          })
        } catch (err: any) {
          log.error('[metadata-auto] fetch suggestion failed', {
            filePath,
            recordingId: match.recordingId,
            error: err?.message || err
          })
          summary.errors++
          item.status = 'error'
          item.method = method
          item.messageCode = 'SUGGESTION_FAILED'
          item.messageDetail = summarizeErrorMessage(err)
          continue
        }

        const updatePayload = suggestion
          ? buildUpdatePayload(filePath, suggestion.suggestion)
          : null
        if (!suggestion || !updatePayload) {
          summary.noMatch++
          item.status = 'no-match'
          item.method = method
          item.messageCode = 'SUGGESTION_EMPTY'
          continue
        }

        try {
          const result = await updateTrackMetadata(updatePayload)
          item.status = 'applied'
          item.method = method
          item.updatedSongInfo = result.songInfo
          item.oldFilePath = result.renamedFrom
          item.messageCode = 'SUCCESS'
          summary.applied++
          if (method === 'fingerprint') {
            summary.fingerprintApplied++
          } else {
            summary.searchApplied++
          }
          try {
            const newRoot = await findSongListRoot(path.dirname(result.songInfo.filePath))
            if (newRoot) touchedSongListRoots.add(newRoot)
            if (result.renamedFrom) {
              const oldRoot = await findSongListRoot(path.dirname(result.renamedFrom))
              if (oldRoot) touchedSongListRoots.add(oldRoot)
            }
          } catch {}
        } catch (err: any) {
          log.error('[metadata-auto] update metadata failed', {
            filePath,
            error: err?.message || err,
            code: err?.code
          })
          summary.errors++
          item.status = 'error'
          item.method = method
          if (err?.code === 'FFMPEG_METADATA_FAILED') {
            item.messageCode = 'FFMPEG_METADATA_FAILED'
            const detail =
              typeof err?.stderr === 'string' && err.stderr.trim()
                ? err.stderr.trim()
                : summarizeErrorMessage(err)
            item.messageDetail = detail
          } else {
            item.messageCode = 'UPDATE_FAILED'
            item.messageDetail = summarizeErrorMessage(err)
          }
        }
      } catch (err: any) {
        log.error('[metadata-auto] unexpected error', { filePath, error: err?.message || err })
        summary.errors++
        item.status = 'error'
        item.messageCode = 'UNKNOWN'
        item.messageDetail = summarizeErrorMessage(err)
      } finally {
        pushProgress('metadata.autoFillProgressRunning', idx + 1, uniquePaths.length)
      }
    }

    for (const root of touchedSongListRoots) {
      try {
        await clearSongListCaches(root)
      } catch {}
    }

    summary.durationMs = Date.now() - startedAt
    pushProgress('metadata.autoFillProgressFinished', uniquePaths.length, uniquePaths.length, {
      extras: { cancelled }
    })
    return summary
  } finally {
    cancelTokens.delete(progressId)
  }
}
