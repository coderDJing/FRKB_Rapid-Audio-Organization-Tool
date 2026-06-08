import { enqueueKeyAnalysisList } from './keyAnalysisQueue'

export const queueUnifiedDisplayWaveforms = (filePaths: string[]) => {
  const normalized = Array.isArray(filePaths)
    ? filePaths.filter((filePath) => typeof filePath === 'string' && filePath.trim().length > 0)
    : []
  if (!normalized.length) return
  enqueueKeyAnalysisList(normalized, 'low', {
    source: 'foreground',
    preemptible: true,
    category: 'waveform-preview',
    waveformOnly: true
  })
}
