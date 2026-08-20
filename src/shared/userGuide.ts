export const USER_GUIDE_STEP_IDS = [
  'browser',
  'songsSource',
  'rekordboxUsb',
  'songsList',
  'filterCurated',
  'setLibrary',
  'mixtapeLibrary',
  'recordingLibrary',
  'horizontal',
  'edit',
  'mixtapeWindow'
] as const

export type UserGuideStepId = (typeof USER_GUIDE_STEP_IDS)[number]

export const USER_GUIDE_AUDIENCES = ['rekordbox', 'general', 'veteran'] as const

export type UserGuideAudience = (typeof USER_GUIDE_AUDIENCES)[number]

export const USER_GUIDE_BROWSER_BEAT_IDS = [
  'browserSource',
  'browserMode',
  'browserLibraries',
  'browserLibraryMenu',
  'browserRekordboxUsb',
  'browserRekordboxUsbMenu',
  'browserTree',
  'browserTreeMenu',
  'browserPlayer'
] as const

export const USER_GUIDE_SONGS_LIST_BEAT_IDS = [
  'songsListBody',
  'songsListReorder',
  'songsListTrackMenu',
  'songsListHeaderMenu'
] as const

export const USER_GUIDE_REKORDBOX_USB_BEAT_IDS = ['rekordboxUsbBody', 'rekordboxUsbMenu'] as const

export const USER_GUIDE_HORIZONTAL_BEAT_IDS = [
  'horizontalOverview',
  'horizontalWaveforms',
  'horizontalTransport',
  'horizontalLink',
  'horizontalBeatSync',
  'horizontalTools',
  'horizontalCues',
  'horizontalRecording'
] as const

export const USER_GUIDE_EDIT_BEAT_IDS = ['editOverview', 'editGrid'] as const

export const USER_GUIDE_MIXTAPE_WINDOW_BEAT_IDS = [
  'mixtapeOverview',
  'mixtapeParams',
  'mixtapeBpm',
  'mixtapeStem'
] as const

export const USER_GUIDE_DEFAULT_BEAT_ID = 'default' as const

export type UserGuideBeatId =
  | typeof USER_GUIDE_DEFAULT_BEAT_ID
  | (typeof USER_GUIDE_BROWSER_BEAT_IDS)[number]
  | (typeof USER_GUIDE_SONGS_LIST_BEAT_IDS)[number]
  | (typeof USER_GUIDE_REKORDBOX_USB_BEAT_IDS)[number]
  | (typeof USER_GUIDE_HORIZONTAL_BEAT_IDS)[number]
  | (typeof USER_GUIDE_EDIT_BEAT_IDS)[number]
  | (typeof USER_GUIDE_MIXTAPE_WINDOW_BEAT_IDS)[number]

export const getUserGuideBeats = (step: UserGuideStepId): UserGuideBeatId[] => {
  if (step === 'browser') return [...USER_GUIDE_BROWSER_BEAT_IDS]
  if (step === 'songsList') return [...USER_GUIDE_SONGS_LIST_BEAT_IDS]
  if (step === 'rekordboxUsb') return [...USER_GUIDE_REKORDBOX_USB_BEAT_IDS]
  if (step === 'horizontal') return [...USER_GUIDE_HORIZONTAL_BEAT_IDS]
  if (step === 'edit') return [...USER_GUIDE_EDIT_BEAT_IDS]
  if (step === 'mixtapeWindow') return [...USER_GUIDE_MIXTAPE_WINDOW_BEAT_IDS]
  return [USER_GUIDE_DEFAULT_BEAT_ID]
}

export const DEV_USER_GUIDE_AS_NEW_USER_ENV = 'FRKB_DEV_USER_GUIDE_AS_NEW_USER'

const USER_GUIDE_STEP_ID_SET = new Set<string>(USER_GUIDE_STEP_IDS)
const USER_GUIDE_AUDIENCE_SET = new Set<string>(USER_GUIDE_AUDIENCES)

export const isUserGuideStepId = (value: unknown): value is UserGuideStepId =>
  typeof value === 'string' && USER_GUIDE_STEP_ID_SET.has(value)

export const isUserGuideAudience = (value: unknown): value is UserGuideAudience =>
  typeof value === 'string' && USER_GUIDE_AUDIENCE_SET.has(value)

export const isEnabledEnvFlag = (value: unknown): boolean => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

export const sanitizeUserGuideDismissedSteps = (value: unknown): UserGuideStepId[] => {
  if (!Array.isArray(value)) return []
  const seen = new Set<UserGuideStepId>()
  const steps: UserGuideStepId[] = []
  for (const item of value) {
    if (!isUserGuideStepId(item) || seen.has(item)) continue
    seen.add(item)
    steps.push(item)
  }
  return steps
}

export const sanitizeUserGuideAudience = (
  value: unknown,
  legacyIsRekordboxUser?: unknown
): UserGuideAudience | undefined => {
  if (isUserGuideAudience(value)) return value
  if (legacyIsRekordboxUser === true) return 'rekordbox'
  if (legacyIsRekordboxUser === false) return 'general'
  return undefined
}
