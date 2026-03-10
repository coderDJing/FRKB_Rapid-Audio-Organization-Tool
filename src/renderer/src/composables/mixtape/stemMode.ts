import choice from '@renderer/components/choiceDialog'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'
import {
  DEFAULT_MIXTAPE_STEM_PROFILE,
  normalizeMixtapeStemProfile,
  type MixtapeStemProfile
} from '@shared/mixtapeStemProfiles'
import { FIXED_MIXTAPE_STEM_MODE } from '@shared/mixtapeStemMode'

export type MixtapeMixMode = 'eq' | 'stem'
export type MixtapeStemMode = typeof FIXED_MIXTAPE_STEM_MODE
export type MixtapeProjectMode = {
  mixMode: MixtapeMixMode
  stemProfile: MixtapeStemProfile
}

export const DEFAULT_MIXTAPE_STEM_MODE: MixtapeStemMode = FIXED_MIXTAPE_STEM_MODE
export const DEFAULT_MIXTAPE_MIX_MODE: MixtapeMixMode = 'stem'

const pendingProjectModeByPlaylistId = new Map<string, MixtapeProjectMode>()

export function normalizeMixtapeMixMode(value: unknown): MixtapeMixMode {
  return value === 'eq' ? 'eq' : 'stem'
}

const normalizeMixtapeProjectMode = (
  value: Partial<MixtapeProjectMode> | null | undefined
): MixtapeProjectMode => {
  const mixMode = normalizeMixtapeMixMode(value?.mixMode)
  const stemProfile = normalizeMixtapeStemProfile(value?.stemProfile, DEFAULT_MIXTAPE_STEM_PROFILE)
  return {
    mixMode,
    stemProfile
  }
}

export async function chooseMixtapeProjectModeForCreate(): Promise<MixtapeProjectMode | null> {
  const result = await choice({
    title: t('mixtape.mixModeCreateTitle'),
    content: [t('mixtape.mixModeCreateHint')],
    options: [
      { key: 'enter', label: t('mixtape.mixModeStemLabel') },
      { key: 'reset', label: t('mixtape.mixModeEqLabel') },
      { key: 'cancel', label: t('common.cancel') }
    ],
    innerHeight: 210,
    innerWidth: 520
  })
  if (result === 'enter') {
    return {
      mixMode: 'stem',
      stemProfile: DEFAULT_MIXTAPE_STEM_PROFILE
    }
  }
  if (result === 'reset') {
    return {
      mixMode: 'eq',
      stemProfile: DEFAULT_MIXTAPE_STEM_PROFILE
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
    if (normalizedProjectMode.mixMode === 'stem') {
      await window.electron.ipcRenderer.invoke('mixtape:project:set-stem-profile', {
        playlistId: normalizedPlaylistId,
        stemProfile: normalizedProjectMode.stemProfile
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
      stemProfile: DEFAULT_MIXTAPE_STEM_PROFILE
    }
  }
  try {
    const mixModeResult = await window.electron.ipcRenderer.invoke('mixtape:project:get-mix-mode', {
      playlistId: normalizedPlaylistId
    })
    const stemProfileResult = await window.electron.ipcRenderer.invoke(
      'mixtape:project:get-stem-profile',
      {
        playlistId: normalizedPlaylistId
      }
    )
    return {
      mixMode: normalizeMixtapeMixMode(mixModeResult?.mixMode),
      stemProfile: normalizeMixtapeStemProfile(
        stemProfileResult?.stemProfile,
        DEFAULT_MIXTAPE_STEM_PROFILE
      )
    }
  } catch (error) {
    console.error('[mixtape] read project mode failed', {
      playlistId: normalizedPlaylistId,
      error
    })
    return {
      mixMode: DEFAULT_MIXTAPE_MIX_MODE,
      stemProfile: DEFAULT_MIXTAPE_STEM_PROFILE
    }
  }
}
