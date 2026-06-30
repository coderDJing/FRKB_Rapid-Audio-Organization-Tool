import type {
  AudioContextConstructor,
  AudioContextWithExtensions,
  WindowWithAudioContext
} from './webAudioPlayer.shared'

/**
 * AudioContext 的创建、全局注册表管理与输出设备路由。
 * 从 WebAudioPlayer 抽出：这些逻辑只依赖 window 全局与传入参数，不触及播放器实例状态。
 */

export const resolveAudioContextConstructor = (): AudioContextConstructor | null => {
  const windowWithAudio = window as WindowWithAudioContext
  return windowWithAudio.AudioContext || windowWithAudio.webkitAudioContext || null
}

export const createAudioContext = (options?: AudioContextOptions): AudioContext | null => {
  const AudioContextCtor = resolveAudioContextConstructor()
  if (!AudioContextCtor) {
    return null
  }
  try {
    const ctx = options ? new AudioContextCtor(options) : new AudioContextCtor()
    // 注册到全局列表，窗口关闭时可立即挂起所有 AudioContext
    const contexts = (window.__FRKB_AUDIO_CONTEXTS__ ??= [])
    contexts.push(ctx)
    return ctx
  } catch {
    return null
  }
}

export const unregisterAudioContext = (ctx: AudioContext): void => {
  try {
    const list = window.__FRKB_AUDIO_CONTEXTS__
    if (list) {
      const idx = list.indexOf(ctx)
      if (idx >= 0) list.splice(idx, 1)
    }
  } catch {}
}

export const applyOutputDeviceToContext = async (
  context: AudioContext,
  deviceId: string
): Promise<void> => {
  const extendedContext = context as AudioContextWithExtensions
  const setSinkId = extendedContext.setSinkId
  if (typeof setSinkId !== 'function') {
    throw new Error('setSinkIdUnsupported')
  }
  await setSinkId.call(extendedContext, deviceId)
}
