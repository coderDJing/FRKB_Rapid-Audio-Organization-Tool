export type TitleAudioVisualizerTarget = 'mainWindow' | 'mixtapeWindow'

export type TitleAudioVisualizerAnalyserLike = Pick<
  AnalyserNode,
  'fftSize' | 'frequencyBinCount' | 'getByteFrequencyData' | 'getByteTimeDomainData'
>

export type TitleAudioVisualizerSource = {
  getAnalyser: () => TitleAudioVisualizerAnalyserLike | null
  priority?: number
}

const sourceStackByTarget: Record<TitleAudioVisualizerTarget, TitleAudioVisualizerSource[]> = {
  mainWindow: [],
  mixtapeWindow: []
}

export const configureTitleAudioVisualizerAnalyser = <T extends AnalyserNode>(analyser: T): T => {
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.04
  analyser.minDecibels = -92
  analyser.maxDecibels = -18
  return analyser
}

export const registerTitleAudioVisualizerSource = (
  target: TitleAudioVisualizerTarget,
  source: TitleAudioVisualizerSource
): void => {
  const stack = sourceStackByTarget[target]
  const existingIndex = stack.indexOf(source)
  if (existingIndex >= 0) {
    stack.splice(existingIndex, 1)
  }
  stack.push(source)
}

export const unregisterTitleAudioVisualizerSource = (
  target: TitleAudioVisualizerTarget,
  source?: TitleAudioVisualizerSource
): void => {
  const stack = sourceStackByTarget[target]
  if (!source) {
    stack.length = 0
    return
  }
  const existingIndex = stack.lastIndexOf(source)
  if (existingIndex >= 0) {
    stack.splice(existingIndex, 1)
  }
}

export const resolveTitleAudioVisualizerAnalyser = (
  target: TitleAudioVisualizerTarget
): TitleAudioVisualizerAnalyserLike | null => {
  try {
    const stack = sourceStackByTarget[target]
    let selectedSource: TitleAudioVisualizerSource | null = null
    let selectedPriority = Number.NEGATIVE_INFINITY
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const candidate = stack[index]
      const priority = Number(candidate?.priority) || 0
      if (selectedSource && priority <= selectedPriority) continue
      selectedSource = candidate
      selectedPriority = priority
    }
    return selectedSource?.getAnalyser() ?? null
  } catch {
    return null
  }
}
