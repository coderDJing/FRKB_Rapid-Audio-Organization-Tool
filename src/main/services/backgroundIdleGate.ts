import { app, powerMonitor } from 'electron'
import { is } from '@electron-toolkit/utils'
import { log } from '../log'

type SystemIdleState = 'active' | 'idle' | 'locked' | 'unknown'
type ForegroundBusyProvider = () => boolean

export type BackgroundIdleProfile = 'active' | 'idle' | 'deep-idle'

export type BackgroundIdleSnapshot = {
  systemIdleSeconds: number
  systemIdleState: SystemIdleState
  systemIdleEnough: boolean
  foregroundBusy: boolean
  allowed: boolean
  profile: BackgroundIdleProfile
  idleThresholdSec: number
  deepIdleThresholdSec: number
}

export const SYSTEM_IDLE_THRESHOLD_SEC = 120
export const SYSTEM_DEEP_IDLE_THRESHOLD_SEC = 300
const DEV_SYSTEM_IDLE_THRESHOLD_SEC = 20
const DEV_SYSTEM_DEEP_IDLE_THRESHOLD_SEC = 30

const foregroundBusyProviderMap = new Map<string, ForegroundBusyProvider>()

const resolveIdleThresholdSec = (): number =>
  is.dev ? DEV_SYSTEM_IDLE_THRESHOLD_SEC : SYSTEM_IDLE_THRESHOLD_SEC

const resolveDeepIdleThresholdSec = (): number =>
  is.dev ? DEV_SYSTEM_DEEP_IDLE_THRESHOLD_SEC : SYSTEM_DEEP_IDLE_THRESHOLD_SEC

const normalizeSystemIdleState = (value: unknown): SystemIdleState => {
  if (value === 'active') return 'active'
  if (value === 'idle') return 'idle'
  if (value === 'locked') return 'locked'
  return 'unknown'
}

const getSystemIdleSecondsSafe = (): number => {
  if (!app.isReady()) return 0
  try {
    const idleSec = Number(powerMonitor.getSystemIdleTime())
    if (!Number.isFinite(idleSec) || idleSec < 0) return 0
    return Math.floor(idleSec)
  } catch {
    return 0
  }
}

const getSystemIdleStateSafe = (thresholdSec: number): SystemIdleState => {
  if (!app.isReady()) return 'active'
  try {
    const threshold = Math.max(1, Number(thresholdSec) || SYSTEM_IDLE_THRESHOLD_SEC)
    return normalizeSystemIdleState(powerMonitor.getSystemIdleState(threshold))
  } catch {
    return 'unknown'
  }
}

const isForegroundBusy = (): boolean => {
  if (foregroundBusyProviderMap.size === 0) return false
  for (const [providerName, provider] of foregroundBusyProviderMap.entries()) {
    try {
      if (provider()) return true
    } catch (error) {
      log.warn('[background-idle-gate] foreground busy provider failed', {
        providerName,
        error
      })
    }
  }
  return false
}

export const registerBackgroundForegroundBusyProvider = (
  providerName: string,
  provider: ForegroundBusyProvider
) => {
  const normalizedName = String(providerName || '').trim()
  if (!normalizedName || typeof provider !== 'function') return
  foregroundBusyProviderMap.set(normalizedName, provider)
}

export const unregisterBackgroundForegroundBusyProvider = (providerName: string) => {
  const normalizedName = String(providerName || '').trim()
  if (!normalizedName) return
  if (!foregroundBusyProviderMap.delete(normalizedName)) return
}

export const getBackgroundIdleSnapshot = (): BackgroundIdleSnapshot => {
  const idleThresholdSec = resolveIdleThresholdSec()
  const deepIdleThresholdSec = resolveDeepIdleThresholdSec()
  const systemIdleSeconds = getSystemIdleSecondsSafe()
  const systemIdleState = getSystemIdleStateSafe(idleThresholdSec)
  const systemIdleEnough = systemIdleSeconds >= idleThresholdSec && systemIdleState !== 'active'
  const foregroundBusy = isForegroundBusy()
  const allowed = systemIdleEnough && !foregroundBusy
  const profile: BackgroundIdleProfile = !allowed
    ? 'active'
    : systemIdleSeconds >= deepIdleThresholdSec
      ? 'deep-idle'
      : 'idle'
  return {
    systemIdleSeconds,
    systemIdleState,
    systemIdleEnough,
    foregroundBusy,
    allowed,
    profile,
    idleThresholdSec,
    deepIdleThresholdSec
  }
}

export const getStemBackgroundConcurrencyHint = () => {
  const snapshot = getBackgroundIdleSnapshot()
  const target = snapshot.profile === 'deep-idle' ? 2 : 1
  return {
    target,
    profile: snapshot.profile,
    allowed: snapshot.allowed,
    foregroundBusy: snapshot.foregroundBusy,
    systemIdleSeconds: snapshot.systemIdleSeconds,
    systemIdleState: snapshot.systemIdleState
  }
}
