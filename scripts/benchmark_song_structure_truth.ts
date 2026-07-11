import { execFileSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { SONG_ANALYSIS_NATIVE_LIBAV_BACKEND } from '../src/main/workers/songAnalysisAudioDecoder'
import type { SongStructureSection } from '../src/shared/songStructureCommon'
import { analyzeSongStructureAudio } from './song_structure_audio_runtime'
import {
  REPO_ROOT,
  SONG_STRUCTURE_MANIFEST_PATH,
  SONG_STRUCTURE_TEST_DATA_ROOT,
  loadSongStructureManifest,
  loadSongStructureTruth,
  readArgument,
  readArguments,
  resolveSongStructureAudioRoot,
  validateSongStructureTruthRepository,
  verifySongStructureAudio,
  writeJsonFile,
  type SongStructureManifestTrack,
  type SongStructurePredictionFile,
  type SongStructureTruthFile
} from './song_structure_truth_common'

const args = process.argv.slice(2)
const HELP_TEXT = `歌曲段落真值 benchmark

用法：
  pnpm run benchmark:song-structure -- [选项]

选项：
  --audio-root <路径>         哈希音频库根目录；也可设置 FRKB_SONG_STRUCTURE_AUDIO_ROOT
  --track <SHA或前缀>         只跑指定样本，可重复
  --split <名称>              只跑 calibration/development/regression/holdout
  --status <名称>             只跑 approved/review-queue/known-failure
  --validate-only             只校验 manifest、truth、baseline，不解码音频
  --verify-hash               benchmark 前重新计算音频 SHA-256
  --absolute-bands            使用 absolute low/mid/high/all 生产特征
  --feature-rate <8|16|32>    absolute 特征帧率，默认 16 Hz
  --write-baseline            写入 baselines/v<algorithmVersion>/ 并登记 manifest
  --overwrite-baseline        允许覆盖已有同版本 prediction（须与 --write-baseline 一起）
  --report <路径>             指定报告路径；默认写入 structure-analysis-lab/reports/
  --no-report                 只输出 stdout，不写本地报告
  --help, -h                  显示本帮助

benchmark 直接调用 src/shared/songStructure 的生产算法核心，不维护测试专用算法副本。
`

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP_TEXT)
  process.exit(0)
}

const toRounded = (value: number, digits = 6) => Number(value.toFixed(digits))

const readGitProvenance = () => {
  try {
    const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    }).trim()
    const dirty =
      execFileSync('git', ['status', '--porcelain'], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
      }).trim().length > 0
    return { gitHead: gitHead || null, dirty }
  } catch {
    return { gitHead: null, dirty: true }
  }
}

type BoundaryMetric = {
  truthCount: number
  predictionCount: number
  matchedCount: number
  precision: number | null
  recall: number | null
  f1: number | null
}

type LabelMetric = {
  evaluatedBars: number
  strictCorrectBars: number
  acceptableCorrectBars: number
  missingPredictionBars: number
  strictAccuracy: number | null
  acceptableAccuracy: number | null
}

type TrackMetric = {
  coverage: SongStructureTruthFile['coverage']
  boundaries: BoundaryMetric
  labels: LabelMetric
}

const divide = (numerator: number, denominator: number) =>
  denominator > 0 ? toRounded(numerator / denominator) : null

const buildF1 = (precision: number | null, recall: number | null) =>
  precision !== null && recall !== null && precision + recall > 0
    ? toRounded((2 * precision * recall) / (precision + recall))
    : precision === 0 || recall === 0
      ? 0
      : null

type EvaluatedSection = Pick<SongStructureSection, 'startBar' | 'endBar' | 'kind'>

const findPredictionAtBar = (sections: readonly EvaluatedSection[], bar: number) =>
  sections.find((section) => section.startBar <= bar && section.endBar >= bar)

const buildTrackMetric = (
  truth: SongStructureTruthFile,
  predictions: readonly EvaluatedSection[]
): TrackMetric | null => {
  if (truth.review.status !== 'approved' || truth.coverage === 'none' || !truth.sections.length) {
    return null
  }

  let evaluatedBars = 0
  let strictCorrectBars = 0
  let acceptableCorrectBars = 0
  let missingPredictionBars = 0
  for (const expected of truth.sections) {
    for (let bar = expected.startBar; bar <= expected.endBar; bar += 1) {
      evaluatedBars += 1
      const prediction = findPredictionAtBar(predictions, bar)
      if (!prediction) {
        missingPredictionBars += 1
        continue
      }
      if (prediction.kind === expected.kind) strictCorrectBars += 1
      if (expected.acceptableKinds.includes(prediction.kind)) acceptableCorrectBars += 1
    }
  }

  const truthBoundaries = truth.sections.slice(1).flatMap((section, index) => {
    const previous = truth.sections[index]
    if (!previous || previous.endBar + 1 !== section.startBar) return []
    return [{ bar: section.startBar, tolerance: section.boundaryToleranceBars.start }]
  })
  const minimumBar = truth.sections[0]?.startBar ?? 1
  const maximumBar = truth.sections.at(-1)?.endBar ?? 0
  const predictionBoundaries = predictions
    .slice(1)
    .map((section) => section.startBar)
    .filter((bar) => bar > minimumBar && bar <= maximumBar)
  const unusedPredictions = new Set(predictionBoundaries.map((_, index) => index))
  let matchedCount = 0
  for (const expected of truthBoundaries) {
    const closest = [...unusedPredictions]
      .map((index) => ({ index, distance: Math.abs(predictionBoundaries[index] - expected.bar) }))
      .filter((candidate) => candidate.distance <= expected.tolerance)
      .sort((left, right) => left.distance - right.distance || left.index - right.index)[0]
    if (!closest) continue
    unusedPredictions.delete(closest.index)
    matchedCount += 1
  }
  const precision = divide(matchedCount, predictionBoundaries.length)
  const recall = divide(matchedCount, truthBoundaries.length)

  return {
    coverage: truth.coverage,
    boundaries: {
      truthCount: truthBoundaries.length,
      predictionCount: predictionBoundaries.length,
      matchedCount,
      precision,
      recall,
      f1: buildF1(precision, recall)
    },
    labels: {
      evaluatedBars,
      strictCorrectBars,
      acceptableCorrectBars,
      missingPredictionBars,
      strictAccuracy: divide(strictCorrectBars, evaluatedBars),
      acceptableAccuracy: divide(acceptableCorrectBars, evaluatedBars)
    }
  }
}

const selectTracks = (tracks: readonly SongStructureManifestTrack[]) => {
  const requestedTracks = readArguments(args, '--track')
  const split = readArgument(args, '--split')
  const status = readArgument(args, '--status')
  if (split && !['calibration', 'development', 'regression', 'holdout'].includes(split)) {
    throw new Error(`无效 --split: ${split}`)
  }
  if (status && !['approved', 'review-queue', 'known-failure'].includes(status)) {
    throw new Error(`无效 --status: ${status}`)
  }
  const selected = tracks.filter((track) => {
    if (split && track.dataset.split !== split) return false
    if (status && track.dataset.status !== status) return false
    if (
      requestedTracks.length &&
      !requestedTracks.some(
        (requested) => track.id.startsWith(requested) || track.title === requested
      )
    ) {
      return false
    }
    return true
  })
  if (!selected.length) throw new Error('筛选后没有可运行样本')
  return selected
}

const ensureBaselineCanWrite = async (filePath: string, overwrite: boolean) => {
  if (overwrite) return
  try {
    await access(filePath)
  } catch {
    return
  }
  throw new Error(`baseline 已存在，拒绝覆盖: ${filePath}`)
}

const main = async () => {
  const manifest = await loadSongStructureManifest()
  await validateSongStructureTruthRepository(manifest)
  const selectedTracks = selectTracks(manifest.tracks)

  if (args.includes('--validate-only')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          valid: true,
          manifestPath: SONG_STRUCTURE_MANIFEST_PATH,
          trackCount: manifest.tracks.length,
          selectedTrackCount: selectedTracks.length,
          splits: Object.fromEntries(
            ['calibration', 'development', 'regression', 'holdout'].map((split) => [
              split,
              manifest.tracks.filter((track) => track.dataset.split === split).length
            ])
          ),
          statuses: Object.fromEntries(
            ['approved', 'review-queue', 'known-failure'].map((status) => [
              status,
              manifest.tracks.filter((track) => track.dataset.status === status).length
            ])
          )
        },
        null,
        2
      )}\n`
    )
    process.exit(0)
  }

  const writeBaseline = args.includes('--write-baseline')
  const overwriteBaseline = args.includes('--overwrite-baseline')
  if (overwriteBaseline && !writeBaseline) {
    throw new Error('--overwrite-baseline 必须和 --write-baseline 一起使用')
  }
  const absoluteBands = args.includes('--absolute-bands')
  const featureRate = Number(readArgument(args, '--feature-rate') ?? 16)
  if (absoluteBands && ![8, 16, 32].includes(featureRate)) {
    throw new Error('--feature-rate 仅支持 8、16、32')
  }
  const audioRoot = resolveSongStructureAudioRoot(manifest, readArgument(args, '--audio-root'))
  const verifyHash = args.includes('--verify-hash')
  const provenance = readGitProvenance()
  const results: Array<{
    trackId: string
    title: string
    dataset: SongStructureManifestTrack['dataset']
    truth: {
      status: SongStructureTruthFile['review']['status']
      coverage: SongStructureTruthFile['coverage']
    }
    prediction?: SongStructurePredictionFile
    metrics?: TrackMetric | null
    error?: string
  }> = []

  for (const track of selectedTracks) {
    try {
      const filePath = await verifySongStructureAudio(audioRoot, track, verifyHash)
      const truth = await loadSongStructureTruth(track)
      const analyzed = analyzeSongStructureAudio(filePath, track.grid, {
        absoluteBands,
        featureRate
      })
      const decoderStrategy =
        analyzed.decoderBackend === SONG_ANALYSIS_NATIVE_LIBAV_BACKEND
          ? 'native-libav-44k1-stereo'
          : analyzed.decoderBackend
      const strategy = absoluteBands
        ? `production-v${analyzed.structure.algorithmVersion}-absolute-${featureRate}hz-${decoderStrategy}`
        : `production-v${analyzed.structure.algorithmVersion}-pseudo-color-${decoderStrategy}`
      const prediction: SongStructurePredictionFile = {
        $schema: '../../schema/prediction.schema.json',
        schemaVersion: 1,
        trackId: track.id,
        generatedAt: new Date().toISOString(),
        algorithm: {
          version: analyzed.structure.algorithmVersion,
          formatVersion: analyzed.structure.formatVersion,
          strategy,
          decoderBackend: analyzed.decoderBackend,
          ...provenance
        },
        durationSec: toRounded(analyzed.durationSec, 3),
        gridKind: track.grid.kind,
        analysisMs: toRounded(analyzed.analysisMs, 3),
        sections: analyzed.structure.sections
      }
      if (writeBaseline) {
        const relativePath = `baselines/v${prediction.algorithm.version}/${track.id}.prediction.json`
        const baselinePath = path.join(SONG_STRUCTURE_TEST_DATA_ROOT, relativePath)
        await ensureBaselineCanWrite(baselinePath, overwriteBaseline)
        await writeJsonFile(baselinePath, prediction)
        if (!track.baselineFiles.includes(relativePath)) {
          track.baselineFiles.push(relativePath)
          track.baselineFiles.sort()
        }
      }
      results.push({
        trackId: track.id,
        title: track.title,
        dataset: track.dataset,
        truth: { status: truth.review.status, coverage: truth.coverage },
        prediction,
        metrics: buildTrackMetric(truth, prediction.sections)
      })
    } catch (error) {
      results.push({
        trackId: track.id,
        title: track.title,
        dataset: track.dataset,
        truth: { status: 'review-queue', coverage: 'none' },
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  if (writeBaseline) await writeJsonFile(SONG_STRUCTURE_MANIFEST_PATH, manifest)

  const scoredMetrics = results.flatMap((result) => (result.metrics ? [result.metrics] : []))
  const aggregate = scoredMetrics.reduce(
    (total, metric) => ({
      scoredTrackCount: total.scoredTrackCount + 1,
      truthBoundaryCount: total.truthBoundaryCount + metric.boundaries.truthCount,
      predictionBoundaryCount: total.predictionBoundaryCount + metric.boundaries.predictionCount,
      matchedBoundaryCount: total.matchedBoundaryCount + metric.boundaries.matchedCount,
      evaluatedBars: total.evaluatedBars + metric.labels.evaluatedBars,
      strictCorrectBars: total.strictCorrectBars + metric.labels.strictCorrectBars,
      acceptableCorrectBars: total.acceptableCorrectBars + metric.labels.acceptableCorrectBars
    }),
    {
      scoredTrackCount: 0,
      truthBoundaryCount: 0,
      predictionBoundaryCount: 0,
      matchedBoundaryCount: 0,
      evaluatedBars: 0,
      strictCorrectBars: 0,
      acceptableCorrectBars: 0
    }
  )
  const boundaryPrecision = divide(
    aggregate.matchedBoundaryCount,
    aggregate.predictionBoundaryCount
  )
  const boundaryRecall = divide(aggregate.matchedBoundaryCount, aggregate.truthBoundaryCount)
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    productionCore: 'src/shared/songStructure.ts#buildSongStructureAnalysis',
    audioRoot,
    selectedTrackCount: selectedTracks.length,
    successfulTrackCount: results.filter((result) => !result.error).length,
    errorTrackCount: results.filter((result) => result.error).length,
    options: { absoluteBands, featureRate, verifyHash, writeBaseline },
    aggregate: {
      ...aggregate,
      boundaryPrecision,
      boundaryRecall,
      boundaryF1: buildF1(boundaryPrecision, boundaryRecall),
      strictLabelAccuracy: divide(aggregate.strictCorrectBars, aggregate.evaluatedBars),
      acceptableLabelAccuracy: divide(aggregate.acceptableCorrectBars, aggregate.evaluatedBars)
    },
    tracks: results
  }

  if (!args.includes('--no-report')) {
    const reportPath = path.resolve(
      readArgument(args, '--report') ||
        path.join(
          REPO_ROOT,
          'structure-analysis-lab',
          'reports',
          `benchmark-${new Date()
            .toISOString()
            .replaceAll(':', '-')
            .replace(/\.\d{3}Z$/, 'Z')}.json`
        )
    )
    await writeJsonFile(reportPath, report)
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.errorTrackCount > 0) process.exitCode = 1
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
