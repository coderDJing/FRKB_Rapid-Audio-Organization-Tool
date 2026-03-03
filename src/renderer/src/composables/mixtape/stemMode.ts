import choice from '@renderer/components/choiceDialog'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import {
  DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE,
  DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE,
  normalizeMixtapeStemProfile,
  type MixtapeStemProfile
} from '@shared/mixtapeStemProfiles'

export type MixtapeMixMode = 'traditional' | 'stem'
export type MixtapeStemMode = '4stems'
export type MixtapeProjectMode = {
  mixMode: MixtapeMixMode
  stemMode: MixtapeStemMode
  stemRealtimeProfile: MixtapeStemProfile
  stemExportProfile: MixtapeStemProfile
  stemStrategyConfirmed: boolean
}

export const DEFAULT_MIXTAPE_STEM_MODE: MixtapeStemMode = '4stems'
export const DEFAULT_MIXTAPE_MIX_MODE: MixtapeMixMode = 'stem'

const pendingProjectModeByPlaylistId = new Map<string, MixtapeProjectMode>()

export function normalizeMixtapeStemMode(_value: unknown): MixtapeStemMode {
  return '4stems'
}

export function normalizeMixtapeMixMode(value: unknown): MixtapeMixMode {
  return value === 'traditional' ? 'traditional' : 'stem'
}

const normalizeMixtapeProjectMode = (
  value: Partial<MixtapeProjectMode> | null | undefined
): MixtapeProjectMode => {
  const mixMode = normalizeMixtapeMixMode(value?.mixMode)
  const stemRealtimeProfile = normalizeMixtapeStemProfile(
    value?.stemRealtimeProfile,
    DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
  )
  const stemExportProfile = normalizeMixtapeStemProfile(
    value?.stemExportProfile,
    DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
  )
  const stemStrategyConfirmed = mixMode === 'stem' ? value?.stemStrategyConfirmed !== false : false
  return {
    mixMode,
    stemMode: normalizeMixtapeStemMode(value?.stemMode),
    stemRealtimeProfile,
    stemExportProfile,
    stemStrategyConfirmed
  }
}

export async function chooseMixtapeProjectModeForCreate(): Promise<MixtapeProjectMode | null> {
  const result = await choice({
    title: t('mixtape.mixModeCreateTitle'),
    content: [t('mixtape.mixModeCreateHint')],
    options: [
      { key: 'enter', label: t('mixtape.mixModeStemLabel') },
      { key: 'reset', label: t('mixtape.mixModeTraditionalLabel') },
      { key: 'cancel', label: t('common.cancel') }
    ],
    innerHeight: 210,
    innerWidth: 520
  })
  if (result === 'enter') {
    const strategy = await choice({
      title: t('mixtape.stemProfileChooseTitle'),
      content: [
        t('mixtape.stemProfileChooseHint'),
        t('mixtape.stemProfileChooseFastHint'),
        t('mixtape.stemProfileChooseQualityHint')
      ],
      options: [
        { key: 'enter', label: t('mixtape.stemProfileChooseFastOption') },
        { key: 'reset', label: t('mixtape.stemProfileChooseQualityOption') },
        { key: 'cancel', label: t('common.cancel') }
      ],
      innerHeight: 240,
      innerWidth: 560
    })
    if (strategy !== 'enter' && strategy !== 'reset') {
      return null
    }
    const stemRealtimeProfile: MixtapeStemProfile = strategy === 'enter' ? 'fast' : 'quality'
    return {
      mixMode: 'stem',
      stemMode: '4stems',
      stemRealtimeProfile,
      stemExportProfile: 'quality',
      stemStrategyConfirmed: true
    }
  }
  if (result === 'reset') {
    return {
      mixMode: 'traditional',
      stemMode: '4stems',
      stemRealtimeProfile: DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE,
      stemExportProfile: DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE,
      stemStrategyConfirmed: false
    }
  }
  return null
}

export function setPendingMixtapeProjectMode(
  playlistId: string,
  projectMode: MixtapeProjectMode
): void {
  const normalizedPlaylistId = typeof playlistId === 'string' ? playlistId.trim() : ''
  if (!normalizedPlaylistId) return
  pendingProjectModeByPlaylistId.set(normalizedPlaylistId, normalizeMixtapeProjectMode(projectMode))
}

export function consumePendingMixtapeProjectMode(playlistId: string): MixtapeProjectMode | null {
  const normalizedPlaylistId = typeof playlistId === 'string' ? playlistId.trim() : ''
  if (!normalizedPlaylistId) return null
  const value = pendingProjectModeByPlaylistId.get(normalizedPlaylistId)
  pendingProjectModeByPlaylistId.delete(normalizedPlaylistId)
  return value || null
}

export function clearPendingMixtapeProjectMode(playlistId: string): void {
  const normalizedPlaylistId = typeof playlistId === 'string' ? playlistId.trim() : ''
  if (!normalizedPlaylistId) return
  pendingProjectModeByPlaylistId.delete(normalizedPlaylistId)
}

export async function persistMixtapeProjectMode(
  playlistId: string,
  projectMode: MixtapeProjectMode
): Promise<boolean> {
  const normalizedPlaylistId = typeof playlistId === 'string' ? playlistId.trim() : ''
  if (!normalizedPlaylistId) return false
  const normalizedProjectMode = normalizeMixtapeProjectMode(projectMode)
  try {
    await window.electron.ipcRenderer.invoke('mixtape:project:set-mix-mode', {
      playlistId: normalizedPlaylistId,
      mixMode: normalizedProjectMode.mixMode
    })
    await window.electron.ipcRenderer.invoke('mixtape:project:set-stem-mode', {
      playlistId: normalizedPlaylistId,
      stemMode: normalizedProjectMode.stemMode
    })
    if (normalizedProjectMode.mixMode === 'stem') {
      await window.electron.ipcRenderer.invoke('mixtape:project:set-stem-profiles', {
        playlistId: normalizedPlaylistId,
        stemRealtimeProfile: normalizedProjectMode.stemRealtimeProfile,
        stemExportProfile: normalizedProjectMode.stemExportProfile,
        markStrategyConfirmed: normalizedProjectMode.stemStrategyConfirmed
      })
    }
    return true
  } catch (error) {
    console.error('[mixtape] persist project mode failed', {
      playlistId: normalizedPlaylistId,
      projectMode: normalizedProjectMode,
      error
    })
    await confirm({
      title: t('common.error'),
      content: [t('mixtape.mixModePersistFailed')],
      confirmShow: false
    })
    return false
  }
}

export async function getMixtapeProjectMode(playlistId: string): Promise<MixtapeProjectMode> {
  const normalizedPlaylistId = typeof playlistId === 'string' ? playlistId.trim() : ''
  if (!normalizedPlaylistId) {
    return {
      mixMode: DEFAULT_MIXTAPE_MIX_MODE,
      stemMode: DEFAULT_MIXTAPE_STEM_MODE,
      stemRealtimeProfile: DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE,
      stemExportProfile: DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE,
      stemStrategyConfirmed: false
    }
  }
  try {
    const mixModeResult = await window.electron.ipcRenderer.invoke('mixtape:project:get-mix-mode', {
      playlistId: normalizedPlaylistId
    })
    const stemModeResult = await window.electron.ipcRenderer.invoke(
      'mixtape:project:get-stem-mode',
      {
        playlistId: normalizedPlaylistId
      }
    )
    const stemProfileResult = await window.electron.ipcRenderer.invoke(
      'mixtape:project:get-stem-profiles',
      {
        playlistId: normalizedPlaylistId
      }
    )
    return {
      mixMode: normalizeMixtapeMixMode(mixModeResult?.mixMode),
      stemMode: normalizeMixtapeStemMode(stemModeResult?.stemMode),
      stemRealtimeProfile: normalizeMixtapeStemProfile(
        stemProfileResult?.stemRealtimeProfile,
        DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE
      ),
      stemExportProfile: normalizeMixtapeStemProfile(
        stemProfileResult?.stemExportProfile,
        DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE
      ),
      stemStrategyConfirmed: !!stemProfileResult?.stemStrategyConfirmed
    }
  } catch (error) {
    console.error('[mixtape] read project mode failed', {
      playlistId: normalizedPlaylistId,
      error
    })
    return {
      mixMode: DEFAULT_MIXTAPE_MIX_MODE,
      stemMode: DEFAULT_MIXTAPE_STEM_MODE,
      stemRealtimeProfile: DEFAULT_MIXTAPE_STEM_REALTIME_PROFILE,
      stemExportProfile: DEFAULT_MIXTAPE_STEM_EXPORT_PROFILE,
      stemStrategyConfirmed: false
    }
  }
}
