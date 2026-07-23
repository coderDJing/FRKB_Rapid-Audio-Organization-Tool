import 'dotenv/config'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  SONG_STRUCTURE_MANIFEST_PATH,
  calculateFileSha256,
  loadSongStructureManifest,
  readArgument,
  resolveSongStructureAudioRoot,
  resolveSongStructureDataPath,
  validateSongStructureManifest,
  validateSongStructureTruthFile,
  writeJsonFile,
  type SongStructureDatasetSplit,
  type SongStructureDatasetStatus,
  type SongStructureTruthFile,
  type SongStructureTruthGrid
} from './song_structure_truth_common'

const args = process.argv.slice(2)
const HELP_TEXT = `添加歌曲段落真值样本

默认仅 dry-run；确认输出后加 --apply 才复制音频并写 manifest/truth 草稿。

固定网格：
  pnpm run song-structure:truth:add -- --file <音频> --title <标题> \\
    --bpm <BPM> --first-beat-ms <毫秒> --downbeat-beat-offset <0..3> [选项]

动态网格：
  pnpm run song-structure:truth:add -- --file <音频> --title <标题> \\
    --grid-json <JSON文件> [选项]

选项：
  --audio-root <路径>         哈希音频库根；也可设置 FRKB_SONG_STRUCTURE_AUDIO_ROOT
  --playlist-root <路径>      实体 truth 歌单根；默认由 FRKB_DEV_DATABASE_URL 推导
  --duration-sec <秒>         可选的已知时长
  --split <名称>              默认 development
  --status <名称>             review-queue（默认）或 known-failure
  --notes <文本>              manifest 备注
  --apply                     同步实体 truth 歌单、哈希音频库与本机真值元数据
  --help, -h                  显示本帮助

grid JSON 格式：
  {"kind":"dynamic","clips":[{"startSec":0,"anchorSec":0.1,"bpm":128,"downbeatBeatOffset":0}, ...]}

该命令只创建 review truth 草稿，绝不把当前算法 prediction 自动批准为人工真值。实体 truth 歌单
与 benchmark 真值集必须同步维护，任一目标发生同名异内容冲突时拒绝写入。
`

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP_TEXT)
  process.exit(0)
}

const requireArgument = (name: string) => {
  const value = readArgument(args, name)?.trim()
  if (!value) throw new Error(`缺少 ${name}`)
  return value
}

const parseFiniteNumber = (name: string, required = true) => {
  const raw = readArgument(args, name)
  if (raw === undefined && !required) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`缺少有效 ${name}`)
  return value
}

const parseRequiredFiniteNumber = (name: string): number => {
  const value = parseFiniteNumber(name)
  if (value === undefined) throw new Error(`缺少有效 ${name}`)
  return value
}

const resolveTruthPlaylistRoot = () => {
  const configured =
    readArgument(args, '--playlist-root')?.trim() ||
    process.env.FRKB_SONG_STRUCTURE_TRUTH_PLAYLIST_ROOT?.trim()
  if (configured) return path.resolve(configured)
  const databaseRoot =
    process.env.FRKB_DEV_DATABASE_URL?.trim() || process.env.FRKB_BENCHMARK_DATABASE_ROOT?.trim()
  if (!databaseRoot) {
    throw new Error(
      '缺少 truth 歌单根：请设置 --playlist-root、FRKB_SONG_STRUCTURE_TRUTH_PLAYLIST_ROOT 或 FRKB_DEV_DATABASE_URL'
    )
  }
  return path.resolve(databaseRoot, 'library', 'FilterLibrary', 'truth')
}

const copyVerifiedAudio = async (sourcePath: string, destinationPath: string, sha256: string) => {
  if (path.resolve(sourcePath) === path.resolve(destinationPath)) return
  await mkdir(path.dirname(destinationPath), { recursive: true })
  try {
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code !== 'EEXIST') throw error
    const destinationHash = await calculateFileSha256(destinationPath)
    if (destinationHash !== sha256) {
      throw new Error(`目标音频已存在但哈希不一致，拒绝覆盖: ${destinationPath}`)
    }
  }
}

const readGrid = async (): Promise<SongStructureTruthGrid> => {
  const gridJsonPath = readArgument(args, '--grid-json')
  if (gridJsonPath) {
    const parsed = JSON.parse(await readFile(path.resolve(gridJsonPath), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--grid-json 必须包含对象')
    }
    const record = parsed as Record<string, unknown>
    if (record.kind !== 'dynamic' || !Array.isArray(record.clips)) {
      throw new Error('--grid-json 必须是 { kind: "dynamic", clips: [...] }')
    }
    return parsed as SongStructureTruthGrid
  }
  const bpm = parseRequiredFiniteNumber('--bpm')
  const firstBeatMs = parseRequiredFiniteNumber('--first-beat-ms')
  const downbeatBeatOffset = parseRequiredFiniteNumber('--downbeat-beat-offset')
  return { kind: 'fixed', bpm, firstBeatMs, downbeatBeatOffset }
}

const main = async () => {
  const filePath = path.resolve(requireArgument('--file'))
  const title = requireArgument('--title')
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) throw new Error('--file 不是文件')
  const sha256 = await calculateFileSha256(filePath)
  const extension = path.extname(filePath).toLowerCase() || '.audio'
  const relativeAudioPath = `${sha256.slice(0, 2)}/${sha256}${extension}`
  const durationSec = parseFiniteNumber('--duration-sec', false)
  if (durationSec !== undefined && durationSec <= 0) throw new Error('--duration-sec 必须大于 0')
  const split = (readArgument(args, '--split') || 'development') as SongStructureDatasetSplit
  if (!['calibration', 'development', 'regression', 'holdout'].includes(split)) {
    throw new Error(`无效 --split: ${split}`)
  }
  const status = (readArgument(args, '--status') || 'review-queue') as SongStructureDatasetStatus
  if (!['review-queue', 'known-failure'].includes(status)) {
    throw new Error('--status 只允许 review-queue 或 known-failure；批准真值必须人工复核后编辑')
  }

  const manifest = await loadSongStructureManifest()
  if (manifest.tracks.some((track) => track.id === sha256)) {
    throw new Error(`样本已存在于 manifest: ${sha256}`)
  }
  const grid = await readGrid()
  const audioRoot = resolveSongStructureAudioRoot(manifest, readArgument(args, '--audio-root'))
  const playlistRoot = resolveTruthPlaylistRoot()
  const truthRelativePath = `tracks/${sha256}.truth.json`
  const truth: SongStructureTruthFile = {
    $schema: '../schema/truth.schema.json',
    schemaVersion: 2,
    trackId: sha256,
    coverage: 'none',
    review: {
      status: 'review-queue',
      source: 'unknown',
      notes: '由添加工具创建；试听并填写 sections 后才能改为 approved。'
    },
    sections: []
  }
  const nextTrack = {
    id: sha256,
    title,
    audio: {
      relativePath: relativeAudioPath,
      sha256,
      sizeBytes: fileStat.size,
      originalFileName: path.basename(filePath)
    },
    ...(durationSec !== undefined ? { durationSec } : {}),
    grid,
    dataset: { split, status },
    truthFile: truthRelativePath,
    baselineFiles: [],
    ...(readArgument(args, '--notes') ? { notes: readArgument(args, '--notes') } : {})
  }
  manifest.tracks.push(nextTrack)
  manifest.tracks.sort((left, right) => left.id.localeCompare(right.id))
  validateSongStructureManifest(manifest)
  validateSongStructureTruthFile(truth, sha256)

  const destinationPath = path.resolve(audioRoot, relativeAudioPath)
  const playlistDestinationPath = path.resolve(playlistRoot, path.basename(filePath))
  const plan = {
    apply: args.includes('--apply'),
    sourcePath: filePath,
    destinationPath,
    playlistDestinationPath,
    manifestPath: SONG_STRUCTURE_MANIFEST_PATH,
    truthPath: resolveSongStructureDataPath(truthRelativePath),
    track: nextTrack
  }

  if (!args.includes('--apply')) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    process.exit(0)
  }

  await copyVerifiedAudio(filePath, destinationPath, sha256)
  await copyVerifiedAudio(filePath, playlistDestinationPath, sha256)
  await writeJsonFile(resolveSongStructureDataPath(truthRelativePath), truth)
  await writeJsonFile(SONG_STRUCTURE_MANIFEST_PATH, manifest)
  process.stdout.write(`${JSON.stringify({ ...plan, completed: true }, null, 2)}\n`)
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
