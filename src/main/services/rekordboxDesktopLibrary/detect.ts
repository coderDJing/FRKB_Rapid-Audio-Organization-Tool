import type { RekordboxDesktopHelperProbePayload, RekordboxDesktopLibraryProbe } from './types'
import { runRekordboxDesktopHelper } from './helper'

const PROBE_CACHE_TTL_MS = 15_000

let probeCache: {
  value: RekordboxDesktopLibraryProbe
  expiresAt: number
} | null = null

const toTrimmedString = (value: unknown) => String(value || '').trim()

const toErrorCode = (value: unknown): RekordboxDesktopLibraryProbe['errorCode'] => {
  const normalized = toTrimmedString(value)
  return normalized ? (normalized as RekordboxDesktopLibraryProbe['errorCode']) : undefined
}

const createUnavailableProbe = (params?: {
  supported?: boolean
  errorCode?: RekordboxDesktopLibraryProbe['errorCode']
  errorMessage?: string
}): RekordboxDesktopLibraryProbe => ({
  available: false,
  supported: params?.supported !== false,
  sourceKey: 'rekordbox-desktop',
  sourceName: 'Rekordbox 本机库',
  sourceRootPath: '',
  dbPath: '',
  dbDir: '',
  shareDir: '',
  playlistTotal: 0,
  folderTotal: 0,
  trackTotal: 0,
  errorCode: params?.errorCode,
  errorMessage: toTrimmedString(params?.errorMessage) || undefined
})

const normalizeProbeError = (error: unknown) => {
  const code = toErrorCode((error as { code?: unknown } | null)?.code)
  const message =
    error instanceof Error
      ? error.message
      : toTrimmedString((error as { message?: unknown } | null)?.message || error)
  return createUnavailableProbe({
    supported: code !== 'UNSUPPORTED_PLATFORM',
    errorCode: code,
    errorMessage: message || '未检测到可读的 Rekordbox 本机库。'
  })
}

const normalizeProbe = (
  payload: RekordboxDesktopHelperProbePayload | null | undefined
): RekordboxDesktopLibraryProbe => {
  const sourceRootPath = toTrimmedString(payload?.sourceRootPath || payload?.shareDir)
  const dbPath = toTrimmedString(payload?.dbPath)
  return {
    available: Boolean(payload?.available),
    supported: payload?.supported !== false,
    sourceKey:
      toTrimmedString(payload?.sourceKey) ||
      (dbPath ? `rekordbox-desktop:${dbPath}` : 'rekordbox-desktop'),
    sourceName: toTrimmedString(payload?.sourceName) || 'Rekordbox 本机库',
    sourceRootPath,
    dbPath,
    dbDir: toTrimmedString(payload?.dbDir),
    shareDir: toTrimmedString(payload?.shareDir || sourceRootPath),
    playlistTotal: Math.max(0, Number(payload?.playlistTotal) || 0),
    folderTotal: Math.max(0, Number(payload?.folderTotal) || 0),
    trackTotal: Math.max(0, Number(payload?.trackTotal) || 0),
    appVersion: toTrimmedString(payload?.appVersion) || undefined,
    libraryVersion: toTrimmedString(payload?.libraryVersion) || undefined,
    errorCode: toErrorCode(payload?.errorCode),
    errorMessage: toTrimmedString(payload?.errorMessage) || undefined
  }
}

export function clearRekordboxDesktopLibraryProbeCache() {
  probeCache = null
}

export async function probeRekordboxDesktopLibrary(
  forceRefresh = false
): Promise<RekordboxDesktopLibraryProbe> {
  if (!forceRefresh && probeCache && probeCache.expiresAt > Date.now()) {
    return probeCache.value
  }

  let probe: RekordboxDesktopLibraryProbe
  try {
    probe = normalizeProbe(
      await runRekordboxDesktopHelper<RekordboxDesktopHelperProbePayload, Record<string, never>>(
        'probe',
        {}
      )
    )
  } catch (error) {
    probe = normalizeProbeError(error)
  }

  probeCache = {
    value: probe,
    expiresAt: Date.now() + PROBE_CACHE_TTL_MS
  }
  return probe
}

export async function requireRekordboxDesktopLibraryProbe() {
  const probe = await probeRekordboxDesktopLibrary(false)
  if (!probe.available) {
    throw new Error(probe.errorMessage || '未检测到可读的 Rekordbox 本机库。')
  }
  return probe
}
