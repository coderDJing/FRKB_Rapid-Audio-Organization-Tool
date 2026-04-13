export type TitleAudioVisualizerTarget = 'mainWindow' | 'mixtapeWindow'

export type TitleAudioVisualizerSource = {
  getAnalyser: () => AnalyserNode | null
}

const sourceByTarget: Record<TitleAudioVisualizerTarget, TitleAudioVisualizerSource | null> = {
  mainWindow: null,
  mixtapeWindow: null
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
  sourceByTarget[target] = source
}

export const unregisterTitleAudioVisualizerSource = (
  target: TitleAudioVisualizerTarget,
  source?: TitleAudioVisualizerSource
): void => {
  if (!source || sourceByTarget[target] === source) {
    sourceByTarget[target] = null
  }
}

export const resolveTitleAudioVisualizerAnalyser = (
  target: TitleAudioVisualizerTarget
): AnalyserNode | null => {
  try {
    return sourceByTarget[target]?.getAnalyser() ?? null
  } catch {
    return null
  }
}
