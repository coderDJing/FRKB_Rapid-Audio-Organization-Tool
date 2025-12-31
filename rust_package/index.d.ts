export type ProcessProgress = {
  processed: number
  total: number
}

export type AudioFileResult = {
  sha256Hash: string
  filePath: string
  error?: string | null
}

export type DecodeAudioResult = {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
  error?: string | null
}

export type SelectionFailed = {
  errorCode: string
  message?: string | null
}

export type TrainSelectionGbdtResult = {
  status: string
  modelRevision?: number | null
  modelPath?: string | null
  failed?: SelectionFailed | null
}

export type PredictSelectionItem = {
  id: string
  score: number
}

export type PredictSelectionCandidatesResult = {
  status: string
  modelRevision?: number | null
  items?: PredictSelectionItem[] | null
  failed?: SelectionFailed | null
}

export type SelectionFeatureStatusItem = {
  songId: string
  hasFeatures: boolean
  hasFullFeatures: boolean
  hasBpm: boolean
  hasKey: boolean
  bpm?: number | null
  key?: string | null
}

export type SelectionBpmKeyFeatures = {
  bpm?: number | null
  key?: string | null
  rmsMean?: number | null
  hpcp?: Buffer | null
  durationSec?: number | null
}

export type SelectionEssentiaFeatures = {
  bpm?: number | null
  key?: string | null
  rmsMean?: number | null
  hpcp?: Buffer | null
  durationSec?: number | null
  essentiaVector?: Buffer | null
}

export type UpsertSongFeaturesInput = {
  songId: string
  fileHash: string
  modelVersion: string
  openl3Vector?: Buffer
  essentiaVector?: Buffer
  chromaprintFingerprint?: string
  rmsMean?: number
  hpcp?: Buffer
  bpm?: number
  key?: string
  durationSec?: number
  bitrateKbps?: number
}

export type SetSelectionLabelsResult = {
  total: number
  changed: number
  sampleChangeCount: number
  sampleChangeDelta: number
}

export type SelectionLabelSnapshot = {
  positiveIds: string[]
  negativeIds: string[]
  sampleChangeCount: number
}

export type SelectionPathIndexEntry = {
  pathKey: string
  filePath: string
  size: number
  mtimeMs: number
  songId: string
  fileHash: string
  updatedAt: number
  lastSeenAt: number
}

export type UpsertSelectionPathIndexEntry = {
  pathKey: string
  filePath: string
  size: number
  mtimeMs: number
  songId: string
  fileHash: string
}

export type SelectionPathIndexGcOptions = {
  ttlDays?: number
  maxRows?: number
  deleteLimit?: number
  minIntervalMs?: number
}

export type SelectionPathIndexGcResult = {
  skipped: boolean
  before: number
  after: number
  deletedOld: number
  deletedOverflow: number
  lastGcAt: number
}

export function upsertSongFeatures(featureStorePath: string, items: UpsertSongFeaturesInput[]): number
export function extractSelectionBpmKeyFeatures(
  filePath: string,
  maxSeconds?: number | null
): Promise<SelectionBpmKeyFeatures>
export function extractSelectionEssentiaFeatures(
  filePath: string,
  maxSeconds?: number | null
): Promise<SelectionEssentiaFeatures>
export function extractOpenL3Embedding(
  filePath: string,
  maxSeconds?: number | null,
  maxWindows?: number | null
): Promise<Buffer>
export function setSelectionLabels(
  labelStorePath: string,
  songIds: string[],
  label: string
): SetSelectionLabelsResult
export function getSelectionLabelSnapshot(labelStorePath: string): SelectionLabelSnapshot
export function resetSelectionSampleChangeCount(labelStorePath: string): number
export function resetSelectionLabels(labelStorePath: string): boolean
export function getSelectionFeatureStatus(
  featureStorePath: string,
  songIds: string[]
): SelectionFeatureStatusItem[]
export function getSelectionPathIndexEntries(
  pathIndexStorePath: string,
  pathKeys: string[]
): SelectionPathIndexEntry[]
export function upsertSelectionPathIndexEntries(
  pathIndexStorePath: string,
  items: UpsertSelectionPathIndexEntry[]
): number
export function touchSelectionPathIndexEntries(pathIndexStorePath: string, pathKeys: string[]): number
export function deleteSelectionPathIndexEntries(pathIndexStorePath: string, pathKeys: string[]): number
export function gcSelectionPathIndex(
  pathIndexStorePath: string,
  options?: SelectionPathIndexGcOptions | null
): SelectionPathIndexGcResult
export function getSelectionLabel(labelStorePath: string, songId: string): string
export function bumpSelectionSampleChangeCount(labelStorePath: string, delta: number): number
export function deleteSelectionPredictionCache(featureStorePath: string, songIds: string[]): number
export function clearSelectionPredictionCache(featureStorePath: string): number
export function trainSelectionGbdt(
  positiveIds: string[],
  negativeIds: string[],
  featureStorePath: string
): TrainSelectionGbdtResult
export function predictSelectionCandidates(
  candidateIds: string[],
  featureStorePath: string,
  modelPath?: string | null,
  topK?: number | null
): PredictSelectionCandidatesResult
export function calculateAudioHashes(filePaths: string[]): AudioFileResult[]
export function calculateAudioHashesWithProgress(
  filePaths: string[],
  callback?: (err: Error | null, progress: ProcessProgress) => void
): Promise<AudioFileResult[]>
export function calculateFileHashes(filePaths: string[]): AudioFileResult[]
export function calculateFileHashesWithProgress(
  filePaths: string[],
  callback?: (err: Error | null, progress: ProcessProgress) => void
): Promise<AudioFileResult[]>
export function decodeAudioFile(filePath: string): DecodeAudioResult
export function decodeAudioFileLimited(filePath: string, maxSeconds: number): Promise<DecodeAudioResult>
