/// <reference types="node" />

export interface ProcessProgress {
  processed: number
  total: number
}

export interface AudioFileResult {
  sha256Hash: string
  filePath: string
  error?: string | null
}

export interface DecodeAudioResult {
  pcmData: Buffer
  sampleRate: number
  channels: number
  totalFrames: number
  error?: string | null
}

export interface SelectionFailed {
  errorCode: string
  message?: string | null
}

export interface TrainSelectionGbdtResult {
  status: string
  modelRevision: number | null
  modelPath: string | null
  failed?: SelectionFailed | null
}

export interface PredictSelectionItem {
  id: string
  score: number
}

export interface PredictSelectionCandidatesResult {
  status: string
  modelRevision: number | null
  items: PredictSelectionItem[] | null
  failed?: SelectionFailed | null
}

export interface SelectionFeatureStatusItem {
  songId: string
  hasFeatures: boolean
}

export interface UpsertSongFeaturesInput {
  songId: string
  fileHash: string
  modelVersion: string
  openl3Vector?: Buffer | null
  chromaprintFingerprint?: string | null
  rmsMean?: number | null
  hpcp?: Buffer | null
  bpm?: number | null
  key?: string | null
  durationSec?: number | null
  bitrateKbps?: number | null
}

export interface SetSelectionLabelsResult {
  total: number
  changed: number
  sampleChangeCount: number
  sampleChangeDelta: number
}

export interface SelectionLabelSnapshot {
  positiveIds: string[]
  negativeIds: string[]
  sampleChangeCount: number
}

export interface SelectionPathIndexEntry {
  pathKey: string
  filePath: string
  size: number
  mtimeMs: number
  songId: string
  fileHash: string
  updatedAt: number
  lastSeenAt: number
}

export interface UpsertSelectionPathIndexEntry {
  pathKey: string
  filePath: string
  size: number
  mtimeMs: number
  songId: string
  fileHash: string
}

export interface SelectionPathIndexGcOptions {
  ttlDays?: number | null
  maxRows?: number | null
  deleteLimit?: number | null
  minIntervalMs?: number | null
}

export interface SelectionPathIndexGcResult {
  skipped: boolean
  before: number
  after: number
  deletedOld: number
  deletedOverflow: number
  lastGcAt: number
}

export type SelectionLabel = 'liked' | 'disliked' | 'neutral'

export function upsertSongFeatures(
  featureStorePath: string,
  items: UpsertSongFeaturesInput[]
): number
export function extractOpenL3Embedding(
  filePath: string,
  maxSeconds?: number | null,
  maxWindows?: number | null
): Promise<Buffer>
export function setSelectionLabels(
  labelStorePath: string,
  songIds: string[],
  label: SelectionLabel | string
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
export function touchSelectionPathIndexEntries(
  pathIndexStorePath: string,
  pathKeys: string[]
): number
export function deleteSelectionPathIndexEntries(
  pathIndexStorePath: string,
  pathKeys: string[]
): number
export function gcSelectionPathIndex(
  pathIndexStorePath: string,
  options?: SelectionPathIndexGcOptions | null
): SelectionPathIndexGcResult
export function getSelectionLabel(
  labelStorePath: string,
  songId: string
): SelectionLabel | string
export function bumpSelectionSampleChangeCount(
  labelStorePath: string,
  delta: number
): number
export function deleteSelectionPredictionCache(
  featureStorePath: string,
  songIds: string[]
): number
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
export function decodeAudioFileLimited(
  filePath: string,
  maxSeconds?: number | null
): Promise<DecodeAudioResult>
