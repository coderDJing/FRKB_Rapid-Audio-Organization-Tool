const fs = require('node:fs')
const path = require('node:path')

const rust = require('../rust_package')

const DRIVE_ROOT = process.argv[2] || 'G:/'
const PLAYLIST_NAME = process.argv[3] || 'abc'
const OUT_PATH = path.resolve(__dirname, 'rekordbox-usb-abc-pqtz-probe.out.json')
const SNAPSHOT_PATH = path.resolve(__dirname, '../resources/rkbRekordboxAbcGridSnapshot.json')

const normalizeText = (value) => String(value || '').trim()
const normalizeKey = (value) => normalizeText(value).toLowerCase()

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readU16BE(buffer, offset) {
  return buffer.readUInt16BE(offset)
}

function readU32BE(buffer, offset) {
  return buffer.readUInt32BE(offset)
}

function parseAnlzSections(filePath) {
  const buffer = fs.readFileSync(filePath)
  const fileKind = buffer.subarray(0, 4).toString('ascii')
  if (fileKind !== 'PMAI') {
    throw new Error(`invalid anlz header for ${filePath}: ${fileKind}`)
  }
  const rootHeaderSize = readU32BE(buffer, 4)
  const rootTotalSize = readU32BE(buffer, 8)
  let offset = rootHeaderSize
  const sections = []
  while (offset < rootTotalSize) {
    const kind = buffer.subarray(offset, offset + 4).toString('ascii')
    const size = readU32BE(buffer, offset + 4)
    const total = readU32BE(buffer, offset + 8)
    const headerData = buffer.subarray(offset + 12, offset + size)
    const content = buffer.subarray(offset + size, offset + total)
    sections.push({
      kind,
      offset,
      size,
      total,
      headerData,
      content
    })
    offset += total
  }
  return sections
}

function parsePqtzSection(section) {
  if (!section || section.kind !== 'PQTZ') return null
  const header = section.headerData
  if (header.length < 12) {
    throw new Error(`PQTZ header too short: ${header.length}`)
  }
  const unknown0 = readU32BE(header, 0)
  const entrySize = readU16BE(header, 4)
  const unknown1 = readU16BE(header, 6)
  const entryCount = readU32BE(header, 8)
  if (entrySize <= 0) {
    throw new Error('PQTZ entrySize invalid')
  }
  const entries = []
  for (let offset = 0; offset + entrySize <= section.content.length; offset += entrySize) {
    const beat = readU16BE(section.content, offset)
    const bpmX100 = readU16BE(section.content, offset + 2)
    const timeMs = readU32BE(section.content, offset + 4)
    entries.push({
      index: entries.length,
      beat,
      bpm: Number((bpmX100 / 100).toFixed(2)),
      timeMs
    })
  }
  return {
    unknown0,
    entrySize,
    unknown1,
    entryCount,
    parsedCount: entries.length,
    entries
  }
}

function parsePqt2Section(section) {
  if (!section || section.kind !== 'PQT2') return null
  const header = section.headerData
  const words = []
  for (let offset = 0; offset + 4 <= header.length; offset += 4) {
    words.push(readU32BE(header, offset))
  }
  return {
    headerByteLength: header.length,
    headerWords: words,
    contentByteLength: section.content.length,
    inferredEntrySize: section.content.length % 8 === 0 ? 8 : null,
    inferredEntryCount: section.content.length % 8 === 0 ? section.content.length / 8 : null,
    firstEntryHex: section.content.subarray(0, Math.min(section.content.length, 32)).toString('hex')
  }
}

function computePqtzStats(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      entryCount: 0,
      uniqueBpmCount: 0,
      bpmValues: [],
      maxBeatTimeDriftMs: 0,
      meanBeatTimeDriftMs: 0,
      maxIntervalDriftMs: 0,
      meanIntervalDriftMs: 0
    }
  }

  const first = entries[0]
  const beatDurationMs = 60000 / first.bpm
  const beatTimeDrifts = entries.map((entry, index) => {
    const expected = first.timeMs + index * beatDurationMs
    return entry.timeMs - expected
  })
  const intervalDrifts = []
  for (let index = 1; index < entries.length; index += 1) {
    const actual = entries[index].timeMs - entries[index - 1].timeMs
    const expected = 60000 / entries[index - 1].bpm
    intervalDrifts.push(actual - expected)
  }

  const bpmValues = Array.from(new Set(entries.map((entry) => entry.bpm))).sort((a, b) => a - b)
  const maxAbs = (values) =>
    values.reduce((max, value) => Math.max(max, Math.abs(Number(value) || 0)), 0)
  const meanAbs = (values) =>
    values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + Math.abs(Number(value) || 0), 0) / values.length

  return {
    entryCount: entries.length,
    uniqueBpmCount: bpmValues.length,
    bpmValues,
    firstEntry: first,
    lastEntry: entries[entries.length - 1],
    maxBeatTimeDriftMs: Number(maxAbs(beatTimeDrifts).toFixed(3)),
    meanBeatTimeDriftMs: Number(meanAbs(beatTimeDrifts).toFixed(3)),
    maxIntervalDriftMs: Number(maxAbs(intervalDrifts).toFixed(3)),
    meanIntervalDriftMs: Number(meanAbs(intervalDrifts).toFixed(3))
  }
}

function buildSnapshotMap() {
  const payload = readJson(SNAPSHOT_PATH)
  const map = new Map()
  for (const track of Array.isArray(payload?.tracks) ? payload.tracks : []) {
    const key = normalizeKey(track?.fileName)
    if (!key || map.has(key)) continue
    map.set(key, {
      fileName: normalizeText(track?.fileName),
      title: normalizeText(track?.title),
      artist: normalizeText(track?.artist),
      bpm: Number(track?.bpm) || 0,
      firstBeatMs: Number(track?.firstBeatMs) || 0,
      barBeatOffset: Number(track?.barBeatOffset) || 0,
      firstBeatLabel: Number(track?.firstBeatLabel) || 0
    })
  }
  return map
}

function findPlaylistId(tree, playlistName) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : []
  const matched = nodes.find(
    (node) =>
      !node?.isFolder && normalizeKey(node?.name) === normalizeKey(playlistName)
  )
  return matched ? Number(matched.id) || 0 : 0
}

function main() {
  const exportPdbPath = path.join(DRIVE_ROOT, 'PIONEER', 'rekordbox', 'export.pdb')
  const tree = rust.readPioneerPlaylistTree(exportPdbPath)
  const playlistId = findPlaylistId(tree, PLAYLIST_NAME)
  if (!playlistId) {
    throw new Error(`playlist not found: ${PLAYLIST_NAME}`)
  }
  const trackDump = rust.readPioneerPlaylistTracks(exportPdbPath, playlistId, 500)
  const tracks = Array.isArray(trackDump?.tracks) ? trackDump.tracks : []
  const snapshotMap = buildSnapshotMap()

  const analyzedTracks = tracks.map((track) => {
    const analyzePath = normalizeText(track?.analyzePath)
    const datPath = path.join(DRIVE_ROOT, analyzePath.replace(/^[/\\]+/, ''))
    const extPath = datPath.replace(/\.DAT$/i, '.EXT')
    const datSections = parseAnlzSections(datPath)
    const extSections = fs.existsSync(extPath) ? parseAnlzSections(extPath) : []
    const pqtz = parsePqtzSection(datSections.find((section) => section.kind === 'PQTZ'))
    const pqt2 = parsePqt2Section(extSections.find((section) => section.kind === 'PQT2'))
    const pqtzStats = computePqtzStats(pqtz?.entries || [])
    const snapshot = snapshotMap.get(normalizeKey(track?.fileName)) || null

    return {
      entryIndex: Number(track?.entryIndex) || 0,
      trackId: Number(track?.trackId) || 0,
      title: normalizeText(track?.title),
      fileName: normalizeText(track?.fileName),
      analyzePath,
      snapshot,
      pqtzHeader: pqtz
        ? {
            unknown0: pqtz.unknown0,
            entrySize: pqtz.entrySize,
            unknown1: pqtz.unknown1,
            entryCount: pqtz.entryCount,
            parsedCount: pqtz.parsedCount
          }
        : null,
      pqtzStats,
      pqtzFirstEntries: (pqtz?.entries || []).slice(0, 8),
      pqtzLastEntries: (pqtz?.entries || []).slice(-8),
      pqt2
    }
  })

  const summary = {
    driveRoot: DRIVE_ROOT,
    playlistName: PLAYLIST_NAME,
    playlistId,
    trackCount: analyzedTracks.length,
    pqtzTrackCount: analyzedTracks.filter((track) => track.pqtzHeader?.parsedCount > 0).length,
    pqt2TrackCount: analyzedTracks.filter((track) => Number(track.pqt2?.inferredEntryCount) > 0).length,
    tracksWithVariableBpm: analyzedTracks
      .filter((track) => Number(track.pqtzStats?.uniqueBpmCount) > 1)
      .map((track) => ({
        entryIndex: track.entryIndex,
        fileName: track.fileName,
        uniqueBpmCount: track.pqtzStats.uniqueBpmCount,
        bpmValues: track.pqtzStats.bpmValues
      })),
    tracksWithLargeBeatDrift: analyzedTracks
      .filter((track) => Number(track.pqtzStats?.maxBeatTimeDriftMs) >= 10)
      .map((track) => ({
        entryIndex: track.entryIndex,
        fileName: track.fileName,
        maxBeatTimeDriftMs: track.pqtzStats.maxBeatTimeDriftMs,
        meanBeatTimeDriftMs: track.pqtzStats.meanBeatTimeDriftMs,
        uniqueBpmCount: track.pqtzStats.uniqueBpmCount
      }))
      .sort((left, right) => right.maxBeatTimeDriftMs - left.maxBeatTimeDriftMs)
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    summary,
    tracks: analyzedTracks
  }

  fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`wrote ${OUT_PATH}`)
}

main()
