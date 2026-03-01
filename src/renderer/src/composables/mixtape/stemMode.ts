import choice from '@renderer/components/choiceDialog'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'

export type MixtapeMixMode = 'traditional' | 'stem'
export type MixtapeStemMode = '4stems'
export type MixtapeProjectMode = {
  mixMode: MixtapeMixMode
  stemMode: MixtapeStemMode
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
  return {
    mixMode,
    stemMode: normalizeMixtapeStemMode(value?.stemMode)
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
    return {
      mixMode: 'stem',
      stemMode: '4stems'
    }
  }
  if (result === 'reset') {
    return {
      mixMode: 'traditional',
      stemMode: '4stems'
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
      stemMode: DEFAULT_MIXTAPE_STEM_MODE
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
    return {
      mixMode: normalizeMixtapeMixMode(mixModeResult?.mixMode),
      stemMode: normalizeMixtapeStemMode(stemModeResult?.stemMode)
    }
  } catch (error) {
    console.error('[mixtape] read project mode failed', {
      playlistId: normalizedPlaylistId,
      error
    })
    return {
      mixMode: DEFAULT_MIXTAPE_MIX_MODE,
      stemMode: DEFAULT_MIXTAPE_STEM_MODE
    }
  }
}
