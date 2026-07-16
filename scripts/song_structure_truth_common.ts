import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createSongBeatGridMapFromClips,
  projectSongBeatGridMapToFixedGrid,
  type SongBeatGridClip
} from '../src/shared/songBeatGridMap'
import {
  createSongBeatGridMapV2FromClips,
  createSongBeatGridMapV2FromFixedGrid,
  type SongBeatGridMapV2
} from '../src/shared/songBeatGridMapV2'
import type {
  BuildSongStructureInput,
  SongStructureAnalysis,
  SongStructureSectionKind
} from '../src/shared/songStructureCommon'
import type { SongStructureSectionV23 } from '../src/shared/songStructureV23'

export const SONG_STRUCTURE_TRUTH_SCHEMA_VERSION = 2
export const SONG_STRUCTURE_PREDICTION_SCHEMA_VERSION = 1
export const SONG_STRUCTURE_SECTION_KINDS = [
  'intro',
  'groove',
  'breakdown',
  'build',
  'drop',
  'outro'
] as const satisfies readonly SongStructureSectionKind[]

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
export const SONG_STRUCTURE_TEST_DATA_ROOT = path.join(REPO_ROOT, 'test-data', 'song-structure')
export const SONG_STRUCTURE_MANIFEST_PATH = path.join(
  SONG_STRUCTURE_TEST_DATA_ROOT,
  'manifest.json'
)

export type SongStructureTruthFixedGrid = {
  kind: 'fixed'
  bpm: number
  firstBeatMs: number
  downbeatBeatOffset: number
}

export type SongStructureTruthDynamicGrid = {
  kind: 'dynamic'
  clips: Array<{
    startSec: number
    anchorSec: number
    bpm: number
    downbeatBeatOffset: number
  }>
}

export type SongStructureTruthGrid = SongStructureTruthFixedGrid | SongStructureTruthDynamicGrid

export type SongStructureDatasetSplit = 'calibration' | 'development' | 'regression' | 'holdout'

export type SongStructureDatasetStatus = 'approved' | 'review-queue' | 'known-failure'

export type SongStructureManifestTrack = {
  id: string
  title: string
  audio: {
    relativePath: string
    sha256: string
    sizeBytes: number
    originalFileName: string
  }
  durationSec?: number
  grid: SongStructureTruthGrid
  dataset: {
    split: SongStructureDatasetSplit
    status: SongStructureDatasetStatus
  }
  truthFile: string
  baselineFiles: string[]
  notes?: string
}

export type SongStructureTruthManifest = {
  $schema?: string
  schemaVersion: number
  audioRootHint?: string
  tracks: SongStructureManifestTrack[]
}

export type SongStructureTruthSection = {
  startDownbeatOrdinal: number
  endDownbeatOrdinal: number
  startSec: number
  endSec: number
  kind: SongStructureSectionKind
  acceptableKinds: SongStructureSectionKind[]
  boundaryToleranceDownbeats: {
    start: number
    end: number
  }
  notes?: string
}

export type SongStructureTruthFile = {
  $schema?: string
  schemaVersion: number
  trackId: string
  coverage: 'none' | 'partial' | 'full'
  review: {
    status: 'review-queue' | 'approved'
    source: 'user-listening' | 'imported' | 'unknown'
    reviewedOn?: string
    notes?: string
  }
  sections: SongStructureTruthSection[]
}

export type SongStructurePredictionSection =
  | (Pick<
      SongStructureAnalysis['sections'][number],
      'startSec' | 'endSec' | 'startBar' | 'endBar' | 'kind' | 'confidence'
    > &
      Partial<
        Pick<
          SongStructureAnalysis['sections'][number],
          'phraseIndex' | 'energy' | 'low' | 'high' | 'novelty'
        >
      >)
  | Pick<
      SongStructureSectionV23,
      | 'startSec'
      | 'endSec'
      | 'startDownbeatOrdinal'
      | 'endDownbeatOrdinal'
      | 'kind'
      | 'confidence'
      | 'energy'
      | 'low'
      | 'high'
      | 'novelty'
    >

export type SongStructurePredictionFile = {
  $schema?: string
  schemaVersion: number
  trackId: string
  generatedAt: string
  algorithm: {
    version: number
    formatVersion: number
    strategy: string
    decoderBackend?: string
    gitHead: string | null
    dirty: boolean
  }
  durationSec: number
  gridKind: SongStructureTruthGrid['kind']
  analysisMs: number
  sections: SongStructurePredictionSection[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertFiniteNumber(value: unknown, message: string): asserts value is number {
  assertCondition(typeof value === 'number' && Number.isFinite(value), message)
}

const normalizeSlash = (value: string) => value.replaceAll('\\', '/')

function assertSafeRelativePath(value: unknown, context: string): asserts value is string {
  assertCondition(typeof value === 'string' && value.trim().length > 0, `${context} 必须是路径`)
  const normalized = normalizeSlash(value)
  assertCondition(!path.isAbsolute(value), `${context} 禁止使用绝对路径`)
  assertCondition(!normalized.split('/').includes('..'), `${context} 禁止跳出数据目录`)
}

export const resolveSongStructureDataPath = (relativePath: string) => {
  assertSafeRelativePath(relativePath, '数据文件路径')
  const resolved = path.resolve(SONG_STRUCTURE_TEST_DATA_ROOT, relativePath)
  const relation = path.relative(SONG_STRUCTURE_TEST_DATA_ROOT, resolved)
  assertCondition(
    relation.length > 0 && !relation.startsWith('..') && !path.isAbsolute(relation),
    `数据文件路径越界: ${relativePath}`
  )
  return resolved
}

function validateGrid(grid: unknown, context: string): asserts grid is SongStructureTruthGrid {
  assertCondition(isRecord(grid), `${context} 必须是对象`)
  if (grid.kind === 'fixed') {
    assertFiniteNumber(grid.bpm, `${context}.bpm 无效`)
    assertCondition(grid.bpm > 0, `${context}.bpm 必须大于 0`)
    assertFiniteNumber(grid.firstBeatMs, `${context}.firstBeatMs 无效`)
    assertFiniteNumber(grid.downbeatBeatOffset, `${context}.downbeatBeatOffset 无效`)
    assertCondition(
      Number.isInteger(grid.downbeatBeatOffset) &&
        grid.downbeatBeatOffset >= 0 &&
        grid.downbeatBeatOffset <= 3,
      `${context}.downbeatBeatOffset 必须是 0..3`
    )
    return
  }
  assertCondition(grid.kind === 'dynamic', `${context}.kind 必须是 fixed 或 dynamic`)
  assertCondition(Array.isArray(grid.clips) && grid.clips.length >= 2, `${context}.clips 至少 2 段`)
  const beatGridMap = createSongBeatGridMapV2FromClips(grid.clips, 'manual', {
    allowSingleClip: true
  })
  assertCondition(beatGridMap !== null, `${context}.clips 不是有效动态网格`)
}

export function validateSongStructureManifest(
  value: unknown
): asserts value is SongStructureTruthManifest {
  assertCondition(isRecord(value), 'manifest 必须是对象')
  assertCondition(
    value.schemaVersion === SONG_STRUCTURE_TRUTH_SCHEMA_VERSION,
    `manifest schemaVersion 必须是 ${SONG_STRUCTURE_TRUTH_SCHEMA_VERSION}`
  )
  assertCondition(Array.isArray(value.tracks), 'manifest.tracks 必须是数组')
  const ids = new Set<string>()
  for (const [index, rawTrack] of value.tracks.entries()) {
    const context = `manifest.tracks[${index}]`
    assertCondition(isRecord(rawTrack), `${context} 必须是对象`)
    assertCondition(
      typeof rawTrack.id === 'string' && /^[a-f0-9]{64}$/.test(rawTrack.id),
      `${context}.id 必须是 SHA-256`
    )
    assertCondition(!ids.has(rawTrack.id), `${context}.id 重复: ${rawTrack.id}`)
    ids.add(rawTrack.id)
    assertCondition(
      typeof rawTrack.title === 'string' && rawTrack.title.trim(),
      `${context}.title 为空`
    )
    assertCondition(isRecord(rawTrack.audio), `${context}.audio 必须是对象`)
    assertCondition(rawTrack.audio.sha256 === rawTrack.id, `${context}.audio.sha256 必须等于 id`)
    assertSafeRelativePath(rawTrack.audio.relativePath, `${context}.audio.relativePath`)
    assertCondition(
      normalizeSlash(rawTrack.audio.relativePath).startsWith(`${rawTrack.id.slice(0, 2)}/`),
      `${context}.audio.relativePath 必须使用哈希前两位分桶`
    )
    assertFiniteNumber(rawTrack.audio.sizeBytes, `${context}.audio.sizeBytes 无效`)
    assertCondition(rawTrack.audio.sizeBytes > 0, `${context}.audio.sizeBytes 必须大于 0`)
    assertCondition(
      typeof rawTrack.audio.originalFileName === 'string' && rawTrack.audio.originalFileName.trim(),
      `${context}.audio.originalFileName 为空`
    )
    if (rawTrack.durationSec !== undefined) {
      assertFiniteNumber(rawTrack.durationSec, `${context}.durationSec 无效`)
      assertCondition(rawTrack.durationSec > 0, `${context}.durationSec 必须大于 0`)
    }
    validateGrid(rawTrack.grid, `${context}.grid`)
    assertCondition(isRecord(rawTrack.dataset), `${context}.dataset 必须是对象`)
    assertCondition(
      ['calibration', 'development', 'regression', 'holdout'].includes(
        String(rawTrack.dataset.split)
      ),
      `${context}.dataset.split 无效`
    )
    assertCondition(
      ['approved', 'review-queue', 'known-failure'].includes(String(rawTrack.dataset.status)),
      `${context}.dataset.status 无效`
    )
    assertSafeRelativePath(rawTrack.truthFile, `${context}.truthFile`)
    assertCondition(
      normalizeSlash(rawTrack.truthFile).startsWith('tracks/'),
      `${context}.truthFile 必须位于 tracks/`
    )
    assertCondition(Array.isArray(rawTrack.baselineFiles), `${context}.baselineFiles 必须是数组`)
    for (const baselineFile of rawTrack.baselineFiles) {
      assertSafeRelativePath(baselineFile, `${context}.baselineFiles[]`)
      assertCondition(
        normalizeSlash(baselineFile).startsWith('baselines/'),
        `${context}.baselineFiles[] 必须位于 baselines/`
      )
    }
  }
}

export function validateSongStructureTruthFile(
  value: unknown,
  expectedTrackId?: string
): asserts value is SongStructureTruthFile {
  assertCondition(isRecord(value), 'truth 文件必须是对象')
  assertCondition(
    value.schemaVersion === SONG_STRUCTURE_TRUTH_SCHEMA_VERSION,
    `truth schemaVersion 必须是 ${SONG_STRUCTURE_TRUTH_SCHEMA_VERSION}`
  )
  assertCondition(
    typeof value.trackId === 'string' && /^[a-f0-9]{64}$/.test(value.trackId),
    'truth.trackId 必须是 SHA-256'
  )
  if (expectedTrackId) {
    assertCondition(value.trackId === expectedTrackId, `truth.trackId 与 manifest 不一致`)
  }
  assertCondition(
    ['none', 'partial', 'full'].includes(String(value.coverage)),
    'truth.coverage 无效'
  )
  assertCondition(isRecord(value.review), 'truth.review 必须是对象')
  assertCondition(
    ['review-queue', 'approved'].includes(String(value.review.status)),
    'truth.review.status 无效'
  )
  assertCondition(
    ['user-listening', 'imported', 'unknown'].includes(String(value.review.source)),
    'truth.review.source 无效'
  )
  assertCondition(Array.isArray(value.sections), 'truth.sections 必须是数组')
  assertCondition(
    value.coverage !== 'none' || value.sections.length === 0,
    'coverage=none 时禁止保存 sections'
  )
  assertCondition(
    value.review.status !== 'approved' || value.coverage !== 'none',
    'approved truth 不能是 coverage=none'
  )
  let previousEndDownbeatOrdinal = 0
  let previousEndSec = 0
  for (const [index, rawSection] of value.sections.entries()) {
    const context = `truth.sections[${index}]`
    assertCondition(isRecord(rawSection), `${context} 必须是对象`)
    assertFiniteNumber(rawSection.startDownbeatOrdinal, `${context}.startDownbeatOrdinal 无效`)
    assertFiniteNumber(rawSection.endDownbeatOrdinal, `${context}.endDownbeatOrdinal 无效`)
    assertCondition(
      Number.isInteger(rawSection.startDownbeatOrdinal) && rawSection.startDownbeatOrdinal >= 0,
      `${context}.startDownbeatOrdinal 必须是非负整数`
    )
    assertCondition(
      Number.isInteger(rawSection.endDownbeatOrdinal) &&
        rawSection.endDownbeatOrdinal > rawSection.startDownbeatOrdinal,
      `${context}.endDownbeatOrdinal 无效`
    )
    assertFiniteNumber(rawSection.startSec, `${context}.startSec 无效`)
    assertFiniteNumber(rawSection.endSec, `${context}.endSec 无效`)
    assertCondition(rawSection.startSec >= 0, `${context}.startSec 不能小于 0`)
    assertCondition(rawSection.endSec > rawSection.startSec, `${context}.endSec 无效`)
    assertCondition(
      SONG_STRUCTURE_SECTION_KINDS.includes(rawSection.kind as SongStructureSectionKind),
      `${context}.kind 无效`
    )
    assertCondition(
      Array.isArray(rawSection.acceptableKinds) && rawSection.acceptableKinds.length > 0,
      `${context}.acceptableKinds 不能为空`
    )
    assertCondition(
      rawSection.acceptableKinds.every((kind) =>
        SONG_STRUCTURE_SECTION_KINDS.includes(kind as SongStructureSectionKind)
      ),
      `${context}.acceptableKinds 含无效标签`
    )
    assertCondition(
      rawSection.acceptableKinds.includes(rawSection.kind),
      `${context}.acceptableKinds 必须包含严格 kind`
    )
    assertCondition(isRecord(rawSection.boundaryToleranceDownbeats), `${context} 缺少边界容差`)
    assertFiniteNumber(rawSection.boundaryToleranceDownbeats.start, `${context}.start 容差无效`)
    assertFiniteNumber(rawSection.boundaryToleranceDownbeats.end, `${context}.end 容差无效`)
    assertCondition(
      Number.isInteger(rawSection.boundaryToleranceDownbeats.start) &&
        rawSection.boundaryToleranceDownbeats.start >= 0,
      `${context}.start 容差必须是非负整数`
    )
    assertCondition(
      Number.isInteger(rawSection.boundaryToleranceDownbeats.end) &&
        rawSection.boundaryToleranceDownbeats.end >= 0,
      `${context}.end 容差必须是非负整数`
    )
    assertCondition(
      rawSection.startDownbeatOrdinal >= previousEndDownbeatOrdinal,
      `${context} 与前一区间重叠`
    )
    assertCondition(rawSection.startSec >= previousEndSec, `${context} 时间与前一区间重叠`)
    if (value.coverage === 'full' && index > 0) {
      assertCondition(
        rawSection.startDownbeatOrdinal === previousEndDownbeatOrdinal,
        `${context} full truth 不能漏四拍块`
      )
    }
    previousEndDownbeatOrdinal = rawSection.endDownbeatOrdinal
    previousEndSec = rawSection.endSec
  }
}

export function validateSongStructurePredictionFile(
  value: unknown,
  expectedTrackId?: string
): asserts value is SongStructurePredictionFile {
  assertCondition(isRecord(value), 'prediction 文件必须是对象')
  assertCondition(
    value.schemaVersion === SONG_STRUCTURE_PREDICTION_SCHEMA_VERSION,
    'prediction 版本无效'
  )
  assertCondition(typeof value.trackId === 'string', 'prediction.trackId 无效')
  if (expectedTrackId) {
    assertCondition(value.trackId === expectedTrackId, 'prediction.trackId 与 manifest 不一致')
  }
  assertCondition(isRecord(value.algorithm), 'prediction.algorithm 无效')
  assertFiniteNumber(value.algorithm.version, 'prediction.algorithm.version 无效')
  if (value.algorithm.decoderBackend !== undefined) {
    assertCondition(
      typeof value.algorithm.decoderBackend === 'string' &&
        value.algorithm.decoderBackend.length > 0,
      'prediction.algorithm.decoderBackend 无效'
    )
  }
  assertCondition(Array.isArray(value.sections), 'prediction.sections 必须是数组')
}

export const readJsonFile = async (filePath: string): Promise<unknown> =>
  JSON.parse(await readFile(filePath, 'utf8')) as unknown

export const writeJsonFile = async (filePath: string, value: unknown) => {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export const loadSongStructureManifest = async () => {
  const value = await readJsonFile(SONG_STRUCTURE_MANIFEST_PATH)
  validateSongStructureManifest(value)
  return value
}

export const loadSongStructureTruth = async (track: SongStructureManifestTrack) => {
  const value = await readJsonFile(resolveSongStructureDataPath(track.truthFile))
  validateSongStructureTruthFile(value, track.id)
  return value
}

export const validateSongStructureTruthRepository = async (
  manifest: SongStructureTruthManifest
) => {
  for (const track of manifest.tracks) {
    const truth = await loadSongStructureTruth(track)
    if (track.dataset.status === 'approved') {
      assertCondition(
        truth.review.status === 'approved' && truth.coverage === 'full',
        `${track.id}: manifest approved 必须对应 full approved truth`
      )
    }
    for (const relativePath of track.baselineFiles) {
      const prediction = await readJsonFile(resolveSongStructureDataPath(relativePath))
      validateSongStructurePredictionFile(prediction, track.id)
    }
  }
}

export const resolveSongStructureAudioRoot = (
  manifest: SongStructureTruthManifest,
  explicitRoot?: string
) => {
  const configured =
    explicitRoot?.trim() ||
    process.env.FRKB_SONG_STRUCTURE_AUDIO_ROOT?.trim() ||
    manifest.audioRootHint
  assertCondition(configured, '缺少音频根：传 --audio-root 或设置 FRKB_SONG_STRUCTURE_AUDIO_ROOT')
  return path.resolve(configured)
}

export const resolveSongStructureAudioPath = (
  audioRoot: string,
  track: SongStructureManifestTrack
) => path.resolve(audioRoot, track.audio.relativePath)

export const resolveSongStructureGridInput = (
  grid: SongStructureTruthGrid,
  durationSec?: number
): Omit<BuildSongStructureInput, 'waveformData' | 'structureFeatureData'> => {
  if (grid.kind === 'fixed') {
    return {
      bpm: grid.bpm,
      firstBeatMs: grid.firstBeatMs,
      barBeatOffset: grid.downbeatBeatOffset
    }
  }
  const beatGridMap = createSongBeatGridMapFromClips(
    grid.clips.map(
      (clip): SongBeatGridClip => ({
        startSec: clip.startSec,
        anchorSec: clip.anchorSec,
        bpm: clip.bpm,
        barBeatOffset: clip.downbeatBeatOffset
      })
    ),
    {
      durationSec,
      allowSingleClip: true
    }
  )
  const projection = projectSongBeatGridMapToFixedGrid(beatGridMap)
  assertCondition(beatGridMap && projection, '动态网格无法生成生产分析输入')
  return { ...projection, beatGridMap }
}

export const resolveSongStructureGridV2Map = (
  grid: SongStructureTruthGrid,
  durationSec?: number
): SongBeatGridMapV2 => {
  const beatGridMap =
    grid.kind === 'fixed'
      ? createSongBeatGridMapV2FromFixedGrid({
          bpm: grid.bpm,
          firstBeatMs: grid.firstBeatMs,
          downbeatBeatOffset: grid.downbeatBeatOffset,
          source: 'analysis'
        })
      : createSongBeatGridMapV2FromClips(
          grid.clips.map((clip) => ({
            startSec: clip.startSec,
            anchorSec: clip.anchorSec,
            bpm: clip.bpm,
            downbeatBeatOffset: clip.downbeatBeatOffset
          })),
          'manual',
          { durationSec, allowSingleClip: true }
        )
  assertCondition(beatGridMap, '段落真值网格无法转换为 v2 四拍网格')
  return beatGridMap
}

export const calculateFileSha256 = async (filePath: string) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export const verifySongStructureAudio = async (
  audioRoot: string,
  track: SongStructureManifestTrack,
  verifyHash: boolean
) => {
  const filePath = resolveSongStructureAudioPath(audioRoot, track)
  await access(filePath)
  const fileStat = await stat(filePath)
  assertCondition(
    fileStat.size === track.audio.sizeBytes,
    `${track.id}: 音频大小与 manifest 不一致`
  )
  if (verifyHash) {
    const sha256 = await calculateFileSha256(filePath)
    assertCondition(sha256 === track.id, `${track.id}: 音频 SHA-256 不一致`)
  }
  return filePath
}

export const readArgument = (args: readonly string[], name: string) => {
  const direct = args.find((arg) => arg.startsWith(`${name}=`))
  if (direct) return direct.slice(name.length + 1)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

export const readArguments = (args: readonly string[], name: string) => {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1))
    if (arg === name && args[index + 1]) values.push(args[index + 1])
  }
  return values
}
