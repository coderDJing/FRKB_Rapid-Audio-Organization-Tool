import { t } from './translate'

export type AcoustIdClientKeyStatus = {
  hasConfiguredKey: boolean
  hasEffectiveKey: boolean
  source: 'setting' | 'dev-env' | ''
}

export function hasConfiguredAcoustIdClientKey(setting?: { acoustIdClientKey?: string }): boolean {
  return String(setting?.acoustIdClientKey || '').trim().length > 0
}

export async function fetchAcoustIdClientKeyStatus(): Promise<AcoustIdClientKeyStatus> {
  try {
    const status = (await window.electron.ipcRenderer.invoke(
      'acoustid:getClientKeyStatus'
    )) as Partial<AcoustIdClientKeyStatus> | null
    return {
      hasConfiguredKey: status?.hasConfiguredKey === true,
      hasEffectiveKey: status?.hasEffectiveKey === true,
      source: status?.source === 'setting' || status?.source === 'dev-env' ? status.source : ''
    }
  } catch {
    return {
      hasConfiguredKey: false,
      hasEffectiveKey: false,
      source: ''
    }
  }
}

export function mapAcoustIdClientError(code?: string): string {
  if (!code) return t('metadata.acoustidKeyVerifyUnknown')
  const normalized = String(code || '').split(':')[0]
  switch (normalized) {
    case 'ACOUSTID_CLIENT_INVALID':
      return t('metadata.acoustidKeyInvalid')
    case 'ACOUSTID_RATE_LIMITED':
      return t('metadata.musicbrainzAcoustIdRateLimited')
    case 'ACOUSTID_TIMEOUT':
      return t('metadata.acoustidKeyVerifyTimeout')
    case 'ACOUSTID_NETWORK':
      return t('metadata.acoustidKeyVerifyNetwork')
    case 'ACOUSTID_ABORTED':
      return t('metadata.acoustidKeyVerifyUnknown')
    default:
      if (normalized.startsWith('ACOUSTID_HTTP_') || normalized === 'ACOUSTID_LOOKUP_FAILED') {
        return t('metadata.acoustidKeyVerifyUnknown')
      }
      return t('metadata.acoustidKeyVerifyUnknown')
  }
}
