import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const SOURCE_ROOT = path.resolve(process.cwd(), 'src')
const SOURCE_EXTENSIONS = new Set(['.ts', '.vue'])

const LEGACY_BAR_BEAT_OFFSET_ALLOWLIST = new Set([
  'main/libraryCacheDb/songBeatGridMapV2Migration.ts',
  'main/libraryCacheDb/songCache.ts',
  'main/services/keyAnalysis/persistence.ts',
  'main/services/keyAnalysis/songCacheEntryPersistence.ts',
  'main/services/keyAnalysis/structurePersistence.ts',
  'main/services/mixtapeAnalysisInfo.ts',
  'main/services/scanSongs.ts',
  'main/services/sharedSongGrid.ts',
  'main/workers/beatThisAnalyzer.ts',
  'shared/songBeatGridMap.ts',
  'shared/songStructure.ts',
  'shared/songStructureAlgorithmic.ts',
  'shared/songStructureAnalysis.ts',
  'shared/songStructureCommon.ts',
  'shared/songStructureDynamicBoundaries.ts',
  'shared/songStructureSpectralFeatures.ts',
  'shared/songStructureWholeSong.ts'
])

const LEGACY_MAP_IMPORT_ALLOWLIST = new Set([
  'main/libraryCacheDb/songBeatGridMapV2Migration.ts',
  'shared/songStructure.ts',
  'shared/songStructureAnalysis.ts',
  'shared/songStructureCommon.ts',
  'shared/songStructureDynamicBoundaries.ts',
  'shared/songStructureSpectralFeatures.ts'
])

const LEGACY_BAR_LINE_ALLOWLIST = new Set([
  'shared/songStructureAnalysis.ts',
  'shared/songStructureDynamicBoundaries.ts',
  'shared/songStructureWholeSong.ts'
])

const CANONICAL_RUNTIME_ONLY_FILES = new Map([
  [
    'renderer/src/workers/horizontalBrowseDetailLiveCanvasOverlay.ts',
    ['request.bpm', 'request.firstBeatMs', 'request.downbeatBeatOffset']
  ],
  [
    'renderer/src/composables/horizontalBrowse/horizontalBrowseDetailMath.ts',
    ['projectSongBeatGridMapV2ToFixedGrid']
  ]
])

const collectSourceFiles = (directory) => {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(absolutePath))
      continue
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue
    if (/\.(spec|test)\.ts$/u.test(entry.name)) continue
    files.push(absolutePath)
  }
  return files
}

const findLines = (text, expression) =>
  text
    .split(/\r?\n/u)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => expression.test(line))

const failures = []
for (const filePath of collectSourceFiles(SOURCE_ROOT)) {
  const relativePath = path.relative(SOURCE_ROOT, filePath).replaceAll('\\', '/')
  const content = fs.readFileSync(filePath, 'utf8')

  if (!LEGACY_BAR_BEAT_OFFSET_ALLOWLIST.has(relativePath)) {
    for (const { number } of findLines(content, /\bbarBeatOffset\b/u)) {
      failures.push(`${relativePath}:${number} uses legacy barBeatOffset`)
    }
  }

  if (!LEGACY_MAP_IMPORT_ALLOWLIST.has(relativePath)) {
    for (const { number } of findLines(content, /songBeatGridMap(?!V2)/u)) {
      failures.push(`${relativePath}:${number} imports or references the legacy map module`)
    }
  }

  if (!LEGACY_BAR_LINE_ALLOWLIST.has(relativePath)) {
    for (const { number } of findLines(content, /\bbar.?line\b/ui)) {
      failures.push(`${relativePath}:${number} uses legacy bar-line terminology`)
    }
  }

  for (const { number } of findLines(content, /\bsong-bpm-updated\b/u)) {
    failures.push(`${relativePath}:${number} broadcasts a legacy root-field grid update`)
  }

  for (const { number } of findLines(content, /%\s*32|%32/u)) {
    failures.push(`${relativePath}:${number} derives a forbidden 32-beat hierarchy`)
  }

  const forbiddenRuntimeInputs = CANONICAL_RUNTIME_ONLY_FILES.get(relativePath)
  if (forbiddenRuntimeInputs) {
    for (const input of forbiddenRuntimeInputs) {
      for (const { number } of findLines(content, new RegExp(input.replace('.', '\\.'), 'u'))) {
        failures.push(`${relativePath}:${number} rebuilds grid from ${input} instead of canonical runtime`)
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[grid-v2-check] legacy symbols outside the allowlist:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('[grid-v2-check] active source only uses v2 grid semantics')
}
