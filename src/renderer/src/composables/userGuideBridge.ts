import { ref } from 'vue'
import type { UserGuideBeatId, UserGuideStepId } from '@shared/userGuide'

type RequestUserGuideStep = (step: UserGuideStepId, options?: { force?: boolean }) => Promise<void>

let requestUserGuideStepHandler: RequestUserGuideStep = async () => {}
let notifyFilterLibraryReceivedSongsHandler = () => {}

export const userGuideSpotlightStep = ref<UserGuideStepId | null>(null)
export const userGuideSpotlightBeat = ref<UserGuideBeatId | null>(null)

export const bindUserGuideHandlers = (handlers: {
  requestStep: RequestUserGuideStep
  notifyFilterLibraryReceivedSongs: () => void
}) => {
  requestUserGuideStepHandler = handlers.requestStep
  notifyFilterLibraryReceivedSongsHandler = handlers.notifyFilterLibraryReceivedSongs
}

export const unbindUserGuideHandlers = () => {
  requestUserGuideStepHandler = async () => {}
  notifyFilterLibraryReceivedSongsHandler = () => {}
}

export const requestUserGuideStep = (
  step: UserGuideStepId,
  options?: { force?: boolean }
): Promise<void> => requestUserGuideStepHandler(step, options)

export const notifyFilterLibraryReceivedSongs = () => {
  notifyFilterLibraryReceivedSongsHandler()
}
