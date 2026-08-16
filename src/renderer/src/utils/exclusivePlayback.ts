import emitter from '@renderer/utils/mitt'

export const EXCLUSIVE_PLAYBACK_PAUSE_OTHERS_EVENT = 'exclusive-playback:pause-others'

export type ExclusivePlaybackOwner =
  | 'stem-preview'
  | 'waveform-preview'
  | 'main-player'
  | 'horizontal-browse'

export type ExclusivePlaybackPauseOthersPayload = {
  owner: ExclusivePlaybackOwner
}

const EXCLUSIVE_PLAYBACK_OWNERS = new Set<ExclusivePlaybackOwner>([
  'stem-preview',
  'waveform-preview',
  'main-player',
  'horizontal-browse'
])

export const isExclusivePlaybackPauseOthersPayload = (
  payload: unknown
): payload is ExclusivePlaybackPauseOthersPayload => {
  if (!payload || typeof payload !== 'object') return false
  const owner = (payload as { owner?: unknown }).owner
  return typeof owner === 'string' && EXCLUSIVE_PLAYBACK_OWNERS.has(owner as ExclusivePlaybackOwner)
}

export const pauseOtherAppPlayback = (owner: ExclusivePlaybackOwner) => {
  emitter.emit(EXCLUSIVE_PLAYBACK_PAUSE_OTHERS_EVENT, {
    owner
  } satisfies ExclusivePlaybackPauseOthersPayload)
  if (owner !== 'waveform-preview') {
    try {
      emitter.emit('waveform-preview:stop', { reason: 'switch' })
    } catch {}
  }
  if (owner !== 'main-player') {
    try {
      emitter.emit('waveform-preview:pause-main')
    } catch {}
  }
}
