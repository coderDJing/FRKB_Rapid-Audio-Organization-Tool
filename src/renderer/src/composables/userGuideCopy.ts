import type { UserGuideBeatId, UserGuideStepId } from '@shared/userGuide'
import { USER_GUIDE_DEFAULT_BEAT_ID } from '@shared/userGuide'
import { t } from '@renderer/utils/translate'

export type UserGuideCardCopy = {
  kicker: string
  title: string
  lines: string[]
  hint: string
}

const collectGuideLines = (prefix: string): string[] => {
  const lines: string[] = []
  for (let index = 1; index <= 6; index += 1) {
    const key = `${prefix}.line${index}`
    const value = t(key)
    if (value === key) break
    lines.push(value)
  }
  return lines
}

const readMessage = (key: string) => {
  const value = t(key)
  return value === key ? '' : value
}

const readCopy = (prefix: string): UserGuideCardCopy => ({
  kicker: readMessage(`${prefix}.kicker`),
  title: t(`${prefix}.title`),
  lines: collectGuideLines(prefix),
  hint: readMessage(`${prefix}.hint`)
})

export const getUserGuideCardCopy = (
  step: UserGuideStepId,
  beat: UserGuideBeatId,
  isRekordboxUser: boolean
): UserGuideCardCopy => {
  if (step === 'filterCurated' || step === 'recordingLibrary') {
    return readCopy(`userGuide.${step}`)
  }
  if (step === 'rekordboxUsb') {
    const sub = beat === 'rekordboxUsbMenu' ? 'rekordboxUsbMenu' : 'rekordboxUsbBody'
    return readCopy(`userGuide.rekordboxUsb.${sub}`)
  }
  const variant = isRekordboxUser ? 'rekordbox' : 'general'
  if (step === 'setLibrary' || step === 'mixtapeLibrary') {
    return readCopy(`userGuide.${step}.${variant}`)
  }
  if (step === 'browser' && beat === 'browserRekordboxUsb') {
    return readCopy('userGuide.rekordboxUsb.rekordboxUsbBody')
  }
  if (step === 'browser' && beat === 'browserRekordboxUsbMenu') {
    return readCopy('userGuide.rekordboxUsb.rekordboxUsbMenu')
  }
  if (step === 'browser' && beat !== USER_GUIDE_DEFAULT_BEAT_ID) {
    return readCopy(`userGuide.browser.${beat}.${variant}`)
  }
  if (step === 'songsList' && beat !== USER_GUIDE_DEFAULT_BEAT_ID) {
    return readCopy(`userGuide.songsList.${beat}.${variant}`)
  }
  if (step === 'horizontal' && beat !== USER_GUIDE_DEFAULT_BEAT_ID) {
    return readCopy(`userGuide.horizontal.${beat}.${variant}`)
  }
  if (step === 'edit' && beat !== USER_GUIDE_DEFAULT_BEAT_ID) {
    return readCopy(`userGuide.edit.${beat}.${variant}`)
  }
  if (step === 'mixtapeWindow' && beat !== USER_GUIDE_DEFAULT_BEAT_ID) {
    return readCopy(`userGuide.mixtapeWindow.${beat}.${variant}`)
  }
  return readCopy(`userGuide.${step}.${variant}`)
}
