import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readManifestFile, writeManifest } from '../../databaseManifest'
import {
  inspectLibraryMergeSource,
  mergeFrkbLibraries,
  recoverIncompleteLibraryMerges
} from './index'

type SqliteDatabase = InstanceType<typeof import('better-sqlite3')>

const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const tempRoots: string[] = []

const makeRoot = async (name: string): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `frkb-library-merge-${name}-`))
  tempRoots.push(root)
  await fs.mkdir(path.join(root, 'library'), { recursive: true })
  const db = new Database(path.join(root, 'FRKB.database.sqlite'))
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE fingerprints (mode TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (mode, hash));
      CREATE TABLE song_cache (
        list_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        info_json TEXT NOT NULL,
        PRIMARY KEY (list_root, file_path)
      );
      CREATE TABLE cover_index (
        list_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        ext TEXT NOT NULL,
        PRIMARY KEY (list_root, file_path)
      );
      CREATE TABLE mixtape_items (
        id TEXT PRIMARY KEY,
        playlist_uuid TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mix_order INTEGER NOT NULL,
        origin_playlist_uuid TEXT,
        origin_path_snapshot TEXT,
        info_json TEXT,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY (playlist_uuid) REFERENCES library_nodes(uuid) ON DELETE CASCADE
      );
      CREATE TABLE mixtape_projects (
        playlist_uuid TEXT PRIMARY KEY,
        mix_mode TEXT NOT NULL DEFAULT 'stem',
        stem_mode TEXT NOT NULL DEFAULT '4stems',
        stem_profile TEXT NOT NULL DEFAULT 'quality',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        info_json TEXT,
        FOREIGN KEY (playlist_uuid) REFERENCES library_nodes(uuid) ON DELETE CASCADE
      );
      CREATE TABLE mixtape_waveform_cache (list_root TEXT PRIMARY KEY);
      CREATE TABLE mixtape_raw_waveform_cache (list_root TEXT PRIMARY KEY);
      CREATE TABLE mixtape_stem_assets (list_root TEXT PRIMARY KEY);
      CREATE TABLE mixtape_stem_waveform_cache (list_root TEXT PRIMARY KEY);
      CREATE TABLE library_stem_assets (library_root TEXT PRIMARY KEY);
      CREATE TABLE set_items (
        id TEXT PRIMARY KEY,
        playlist_uuid TEXT NOT NULL,
        file_path TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        origin_playlist_uuid TEXT,
        origin_path_snapshot TEXT,
        analysis_json TEXT,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY (playlist_uuid) REFERENCES library_nodes(uuid) ON DELETE CASCADE
      );
      CREATE TABLE library_nodes (
        uuid TEXT PRIMARY KEY,
        parent_uuid TEXT,
        dir_name TEXT NOT NULL,
        node_type TEXT NOT NULL,
        sort_order INTEGER,
        FOREIGN KEY (parent_uuid) REFERENCES library_nodes(uuid) ON DELETE CASCADE
      );
      PRAGMA user_version = 35;
    `)
    const insertNode = db.prepare(
      'INSERT INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    )
    insertNode.run('root', null, 'library', 'root', 1)
    for (const [name, order] of [
      ['FilterLibrary', 1],
      ['CuratedLibrary', 2],
      ['SetLibrary', 3],
      ['MixtapeLibrary', 4],
      ['RecordingLibrary', 5],
      ['RecycleBin', 6]
    ] as const) {
      insertNode.run(`${name}-uuid`, 'root', name, 'library', order)
      await fs.mkdir(path.join(root, 'library', name), { recursive: true })
    }
  } finally {
    db.close()
  }
  await writeManifest(root, '1.2.1')
  return root
}

const openDb = (root: string): SqliteDatabase =>
  new Database(path.join(root, 'FRKB.database.sqlite'), { fileMustExist: true })

const updateManifest = async (root: string, changes: Record<string, unknown>): Promise<void> => {
  const manifestPath = path.join(root, 'FRKB.database.frkbdb')
  const manifest = await readManifestFile(manifestPath)
  await fs.writeFile(manifestPath, `${JSON.stringify({ ...manifest, ...changes })}\n`, 'utf8')
}

const addSongList = async (params: {
  root: string
  parentName: string
  playlistName: string
  fileName: string
  content: string
  withCache?: boolean
}) => {
  const db = openDb(params.root)
  try {
    const filter = db
      .prepare(
        'SELECT uuid FROM library_nodes WHERE parent_uuid IS NOT NULL AND dir_name = ? LIMIT 1'
      )
      .get('FilterLibrary') as { uuid: string }
    const existingDirectory = db
      .prepare('SELECT uuid FROM library_nodes WHERE parent_uuid = ? AND dir_name = ? LIMIT 1')
      .get(filter.uuid, params.parentName) as { uuid: string } | undefined
    const directoryUuid =
      existingDirectory?.uuid || `${params.parentName}-dir-${Math.random().toString(16).slice(2)}`
    const playlistUuid = `${params.playlistName}-list-${Math.random().toString(16).slice(2)}`
    if (!existingDirectory) {
      db.prepare(
        'INSERT INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order) VALUES (?, ?, ?, ?, ?)'
      ).run(directoryUuid, filter.uuid, params.parentName, 'dir', 100)
    }
    db.prepare(
      'INSERT INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(playlistUuid, directoryUuid, params.playlistName, 'songList', 100)
    const songListRoot = path.join(
      params.root,
      'library',
      'FilterLibrary',
      params.parentName,
      params.playlistName
    )
    await fs.mkdir(songListRoot, { recursive: true })
    const filePath = path.join(songListRoot, params.fileName)
    await fs.writeFile(filePath, params.content, 'utf8')
    const stat = await fs.stat(filePath)
    if (params.withCache) {
      db.prepare(
        'INSERT INTO song_cache (list_root, file_path, size, mtime_ms, info_json) VALUES (?, ?, ?, ?, ?)'
      ).run(
        path.join('library', 'FilterLibrary', params.parentName, params.playlistName),
        params.fileName,
        stat.size,
        stat.mtimeMs,
        JSON.stringify({ filePath, bpm: 126, key: '8A', hotCues: [{ start: 1 }] })
      )
      db.prepare('INSERT INTO fingerprints (mode, hash) VALUES (?, ?)').run(
        'file',
        `hash-${params.fileName}`
      )
      db.prepare(
        'INSERT INTO cover_index (list_root, file_path, hash, ext) VALUES (?, ?, ?, ?)'
      ).run(
        path.join('library', 'FilterLibrary', params.parentName, params.playlistName),
        params.fileName,
        `cover-${params.fileName}`,
        '.jpg'
      )
    }
    return { songListRoot, filePath }
  } finally {
    db.close()
  }
}

const addEmptySongList = async (params: {
  root: string
  parentName: string
  playlistName: string
}) => {
  const db = openDb(params.root)
  try {
    const filter = db
      .prepare(
        'SELECT uuid FROM library_nodes WHERE parent_uuid IS NOT NULL AND dir_name = ? LIMIT 1'
      )
      .get('FilterLibrary') as { uuid: string }
    const directoryUuid = `empty-dir-${Math.random().toString(16).slice(2)}`
    const playlistUuid = `empty-list-${Math.random().toString(16).slice(2)}`
    db.prepare(
      'INSERT INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(directoryUuid, filter.uuid, params.parentName, 'dir', 100)
    db.prepare(
      'INSERT INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(playlistUuid, directoryUuid, params.playlistName, 'songList', 100)
    const songListRoot = path.join(
      params.root,
      'library',
      'FilterLibrary',
      params.parentName,
      params.playlistName
    )
    await fs.mkdir(songListRoot, { recursive: true })
    return { songListRoot, playlistUuid }
  } finally {
    db.close()
  }
}

const addSetList = async (params: {
  root: string
  playlistName: string
  fileName: string
  content: string
}) => {
  const db = openDb(params.root)
  try {
    const core = db
      .prepare('SELECT uuid FROM library_nodes WHERE dir_name = ? LIMIT 1')
      .get('SetLibrary') as { uuid: string }
    const playlistUuid = `set-list-${Math.random().toString(16).slice(2)}`
    db.prepare(
      'INSERT INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(playlistUuid, core.uuid, params.playlistName, 'setList', 100)
    await fs.mkdir(path.join(params.root, 'library', 'SetLibrary', params.playlistName), {
      recursive: true
    })
    const custodyDir = path.join(params.root, 'library', 'SetLibrary', '__set_custody__')
    await fs.mkdir(custodyDir, { recursive: true })
    const filePath = path.join(custodyDir, params.fileName)
    await fs.writeFile(filePath, params.content, 'utf8')
    db.prepare(
      `INSERT INTO set_items (
        id, playlist_uuid, file_path, sort_order, origin_playlist_uuid,
        origin_path_snapshot, analysis_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `set-item-${Math.random().toString(16).slice(2)}`,
      playlistUuid,
      filePath,
      1,
      null,
      null,
      JSON.stringify({ bpm: 124, hotCues: [{ start: 1 }] }),
      Date.now()
    )
    return { playlistUuid, filePath }
  } finally {
    db.close()
  }
}

const addMixtapeList = async (params: {
  root: string
  playlistName: string
  fileName: string
  content: string
}) => {
  const db = openDb(params.root)
  try {
    const core = db
      .prepare('SELECT uuid FROM library_nodes WHERE dir_name = ? LIMIT 1')
      .get('MixtapeLibrary') as { uuid: string }
    const playlistUuid = `mixtape-list-${Math.random().toString(16).slice(2)}`
    db.prepare(
      'INSERT INTO library_nodes (uuid, parent_uuid, dir_name, node_type, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).run(playlistUuid, core.uuid, params.playlistName, 'mixtapeList', 100)
    await fs.mkdir(path.join(params.root, 'library', 'MixtapeLibrary', params.playlistName), {
      recursive: true
    })
    const vaultDir = path.join(params.root, 'library', 'MixtapeLibrary', '.mixtape_vault')
    await fs.mkdir(vaultDir, { recursive: true })
    const filePath = path.join(vaultDir, params.fileName)
    await fs.writeFile(filePath, params.content, 'utf8')
    db.prepare(
      `INSERT INTO mixtape_items (
        id, playlist_uuid, file_path, mix_order, origin_playlist_uuid,
        origin_path_snapshot, info_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `mixtape-item-${Math.random().toString(16).slice(2)}`,
      playlistUuid,
      filePath,
      1,
      null,
      null,
      JSON.stringify({ filePath, gain: 1, stemStatus: 'ready', stemVocalPath: '/stale/vocal.wav' }),
      Date.now()
    )
    db.prepare(
      `INSERT INTO mixtape_projects (
        playlist_uuid, mix_mode, stem_mode, stem_profile, created_at_ms, updated_at_ms, info_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      playlistUuid,
      'stem',
      '4stems',
      'quality',
      Date.now(),
      Date.now(),
      JSON.stringify({ bpm: 128 })
    )
    return { playlistUuid, filePath }
  } finally {
    db.close()
  }
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

describe('FRKB library merge service', () => {
  it('copies a regular library, renames a colliding playlist, and remaps cache rows', async () => {
    const targetRoot = await makeRoot('target')
    const sourceRoot = await makeRoot('source')
    await addSongList({
      root: targetRoot,
      parentName: 'House',
      playlistName: 'Favorites',
      fileName: 'target.mp3',
      content: 'target'
    })
    await addSongList({
      root: sourceRoot,
      parentName: 'House',
      playlistName: 'Favorites',
      fileName: 'source.mp3',
      content: 'source',
      withCache: true
    })

    const inspection = await inspectLibraryMergeSource({
      sourceRoot,
      targetRoot,
      appVersion: '1.2.1'
    })
    expect(inspection.songListCount).toBe(1)
    expect(inspection.renamedSongListCount).toBe(1)
    expect(inspection.copiedFileCount).toBe(1)

    const result = await mergeFrkbLibraries({
      sourceRoot,
      targetRoot,
      appVersion: '1.2.1',
      mode: 'copy'
    })

    expect(result.sourceDeleted).toBe(false)
    expect(result.renamedSongListCount).toBe(1)
    expect(result.mergedFingerprintCount).toBe(1)
    expect(result.copiedAnalysisRows).toBe(1)
    const importedName = `Favorites (from ${result.sourceLabel})`
    const importedRoot = path.join(targetRoot, 'library', 'FilterLibrary', 'House', importedName)
    const importedFile = path.join(importedRoot, 'source.mp3')
    expect(await fs.readFile(importedFile, 'utf8')).toBe('source')
    expect(
      await fs.readFile(
        path.join(sourceRoot, 'library', 'FilterLibrary', 'House', 'Favorites', 'source.mp3'),
        'utf8'
      )
    ).toBe('source')

    const db = openDb(targetRoot)
    try {
      const node = db
        .prepare('SELECT uuid FROM library_nodes WHERE dir_name = ? LIMIT 1')
        .get(importedName) as { uuid: string } | undefined
      expect(node?.uuid).toBeTruthy()
      const cache = db
        .prepare('SELECT list_root, file_path, info_json FROM song_cache WHERE file_path = ?')
        .get('source.mp3') as
        | { list_root: string; file_path: string; info_json: string }
        | undefined
      expect(cache?.list_root).toBe(path.join('library', 'FilterLibrary', 'House', importedName))
      expect(JSON.parse(cache?.info_json || '{}').filePath).toBe(importedFile)
      const coverCacheRows = db.prepare('SELECT COUNT(*) AS count FROM cover_index').get() as {
        count: number
      }
      expect(coverCacheRows.count).toBe(0)
      const fingerprint = db
        .prepare('SELECT hash FROM fingerprints WHERE mode = ? AND hash = ?')
        .get('file', 'hash-source.mp3') as { hash: string } | undefined
      expect(fingerprint?.hash).toBe('hash-source.mp3')
      const foreignRows = db.pragma('foreign_key_check') as Array<Record<string, unknown>>
      expect(foreignRows).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('skips rebuildable library cache directories and their contents', async () => {
    const targetRoot = await makeRoot('target-cache-directories')
    const sourceRoot = await makeRoot('source-cache-directories')
    const sourceRecordingRoot = path.join(sourceRoot, 'library', 'RecordingLibrary')
    const cachedCoversRoot = path.join(sourceRecordingRoot, '.frkb_covers')
    await fs.mkdir(cachedCoversRoot, { recursive: true })
    await fs.writeFile(path.join(sourceRecordingRoot, 'session.wav'), 'recording', 'utf8')
    await fs.writeFile(path.join(cachedCoversRoot, '.index.json'), '{"version":1}\n', 'utf8')
    await fs.writeFile(path.join(cachedCoversRoot, 'cover.jpg'), 'cover-cache', 'utf8')

    const inspection = await inspectLibraryMergeSource({ sourceRoot, targetRoot })
    expect(inspection.copiedFileCount).toBe(1)

    const result = await mergeFrkbLibraries({ sourceRoot, targetRoot, mode: 'copy' })
    expect(result.copiedFileCount).toBe(1)
    await expect(
      fs.readFile(path.join(targetRoot, 'library', 'RecordingLibrary', 'session.wav'), 'utf8')
    ).resolves.toBe('recording')
    await expect(
      fs.access(path.join(targetRoot, 'library', 'RecordingLibrary', '.frkb_covers'))
    ).rejects.toThrow()
  })

  it('unions audio fingerprints and curated artist records', async () => {
    const targetRoot = await makeRoot('target-curated-artists')
    const sourceRoot = await makeRoot('source-curated-artists')
    const targetFingerprint = 'a'.repeat(64)
    const sourceFingerprint = 'b'.repeat(64)
    const sourceOnlyFingerprint = 'c'.repeat(64)
    const curatedKey = 'curated_artist_library_v1'

    const targetDb = openDb(targetRoot)
    try {
      targetDb
        .prepare('INSERT INTO fingerprints (mode, hash) VALUES (?, ?)')
        .run('file', targetFingerprint)
      targetDb
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run(
          curatedKey,
          JSON.stringify([{ name: 'DJ Sample', count: 2, fingerprints: [targetFingerprint] }])
        )
    } finally {
      targetDb.close()
    }

    const sourceDb = openDb(sourceRoot)
    try {
      sourceDb
        .prepare('INSERT INTO fingerprints (mode, hash) VALUES (?, ?)')
        .run('file', targetFingerprint)
      sourceDb
        .prepare('INSERT INTO fingerprints (mode, hash) VALUES (?, ?)')
        .run('pcm', sourceFingerprint)
      sourceDb.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        curatedKey,
        JSON.stringify([
          { name: 'dj sample', count: 3, fingerprints: [sourceFingerprint] },
          { name: 'Source Only', count: 2, fingerprints: [sourceOnlyFingerprint] }
        ])
      )
    } finally {
      sourceDb.close()
    }

    const result = await mergeFrkbLibraries({ sourceRoot, targetRoot, mode: 'copy' })

    expect(result.mergedFingerprintCount).toBe(1)
    const mergedDb = openDb(targetRoot)
    try {
      const fingerprints = mergedDb
        .prepare('SELECT mode, hash FROM fingerprints ORDER BY mode, hash')
        .all() as Array<{ mode: string; hash: string }>
      expect(fingerprints).toEqual([
        { mode: 'file', hash: targetFingerprint },
        { mode: 'pcm', hash: sourceFingerprint }
      ])
      const curated = mergedDb.prepare('SELECT value FROM meta WHERE key = ?').get(curatedKey) as
        | { value: string }
        | undefined
      expect(JSON.parse(curated?.value || '[]')).toEqual([
        {
          name: 'DJ Sample',
          count: 5,
          fingerprints: [targetFingerprint, sourceFingerprint]
        },
        {
          name: 'Source Only',
          count: 2,
          fingerprints: [sourceOnlyFingerprint]
        }
      ])
    } finally {
      mergedDb.close()
    }
  })

  it('rejects the current library and a copied library identity as a merge source', async () => {
    const targetRoot = await makeRoot('target-same-library')
    await expect(
      inspectLibraryMergeSource({ sourceRoot: targetRoot, targetRoot, appVersion: '1.2.1' })
    ).rejects.toMatchObject({ code: 'SOURCE_EQUALS_TARGET' })
    await expect(
      mergeFrkbLibraries({ sourceRoot: targetRoot, targetRoot, mode: 'copy' })
    ).rejects.toMatchObject({ code: 'SOURCE_EQUALS_TARGET' })
    await expect(fs.access(path.join(targetRoot, '.frkb-merge'))).rejects.toThrow()

    const sourceRoot = await makeRoot('source-same-library')
    const targetManifest = await readManifestFile(path.join(targetRoot, 'FRKB.database.frkbdb'))
    await updateManifest(sourceRoot, { uuid: targetManifest.uuid })
    await expect(
      inspectLibraryMergeSource({ sourceRoot, targetRoot, appVersion: '1.2.1' })
    ).rejects.toMatchObject({ code: 'SOURCE_EQUALS_TARGET' })
  })

  it('rejects a source metadata key that has no merge contract', async () => {
    const targetRoot = await makeRoot('target-unknown-meta')
    const sourceRoot = await makeRoot('source-unknown-meta')
    const sourceDb = openDb(sourceRoot)
    try {
      sourceDb
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('future_feature_state_v1', '{}')
    } finally {
      sourceDb.close()
    }

    await expect(
      inspectLibraryMergeSource({ sourceRoot, targetRoot, appVersion: '1.2.1' })
    ).rejects.toMatchObject({ code: 'SOURCE_METADATA_UNSUPPORTED' })
  })

  it('rejects libraries whose app, manifest, or database schema versions are incompatible', async () => {
    const targetRoot = await makeRoot('target-version')
    const sourceRoot = await makeRoot('source-version')

    await updateManifest(sourceRoot, { minAppVersion: '9.0.0' })
    await expect(
      inspectLibraryMergeSource({ sourceRoot, targetRoot, appVersion: '1.2.1' })
    ).rejects.toMatchObject({ code: 'SOURCE_VERSION_INCOMPATIBLE' })

    await updateManifest(sourceRoot, { minAppVersion: '1.2.1', version: 3 })
    await expect(
      inspectLibraryMergeSource({ sourceRoot, targetRoot, appVersion: '1.2.1' })
    ).rejects.toMatchObject({ code: 'SOURCE_VERSION_INCOMPATIBLE' })

    await updateManifest(sourceRoot, { version: 2 })
    const sourceDb = openDb(sourceRoot)
    try {
      sourceDb.pragma('user_version = 36')
    } finally {
      sourceDb.close()
    }
    await expect(
      inspectLibraryMergeSource({ sourceRoot, targetRoot, appVersion: '1.2.1' })
    ).rejects.toMatchObject({ code: 'SOURCE_SCHEMA_UNSUPPORTED' })

    const restoredSourceDb = openDb(sourceRoot)
    try {
      restoredSourceDb.pragma('user_version = 35')
    } finally {
      restoredSourceDb.close()
    }
    await updateManifest(targetRoot, { minAppVersion: '9.0.0' })
    await expect(
      inspectLibraryMergeSource({ sourceRoot, targetRoot, appVersion: '1.2.1' })
    ).rejects.toMatchObject({ code: 'TARGET_VERSION_INCOMPATIBLE' })
  })

  it('upgrades an older source schema in an isolated snapshot without modifying the source', async () => {
    const targetRoot = await makeRoot('target-schema-snapshot')
    const sourceRoot = await makeRoot('source-schema-snapshot')
    await addSongList({
      root: sourceRoot,
      parentName: 'House',
      playlistName: 'Incoming',
      fileName: 'source.mp3',
      content: 'source',
      withCache: true
    })
    const sourceDb = openDb(sourceRoot)
    try {
      sourceDb.pragma('user_version = 34')
    } finally {
      sourceDb.close()
    }

    const inspection = await inspectLibraryMergeSource({
      sourceRoot,
      targetRoot,
      appVersion: '1.2.1'
    })
    expect(inspection.songListCount).toBe(1)
    const result = await mergeFrkbLibraries({ sourceRoot, targetRoot, mode: 'copy' })

    expect(result.songListCount).toBe(1)
    const sourceDbAfterMerge = openDb(sourceRoot)
    try {
      expect(sourceDbAfterMerge.pragma('user_version', { simple: true })).toBe(34)
    } finally {
      sourceDbAfterMerge.close()
    }
    await expect(
      fs.access(
        path.join(targetRoot, 'library', 'FilterLibrary', 'House', 'Incoming', 'source.mp3')
      )
    ).resolves.toBeUndefined()
  })

  it('deletes the source only after a successful target merge', async () => {
    const targetRoot = await makeRoot('target-delete')
    const sourceRoot = await makeRoot('source-delete')
    await addSongList({
      root: sourceRoot,
      parentName: 'Techno',
      playlistName: 'Incoming',
      fileName: 'track.mp3',
      content: 'track'
    })

    const result = await mergeFrkbLibraries({ sourceRoot, targetRoot, mode: 'delete-source' })

    expect(result.sourceDeleted).toBe(true)
    await expect(fs.access(sourceRoot)).rejects.toThrow()
    expect(
      await fs.readFile(
        path.join(targetRoot, 'library', 'FilterLibrary', 'Techno', 'Incoming', 'track.mp3'),
        'utf8'
      )
    ).toBe('track')
  })

  it('adds a numeric suffix when the generated from-name already exists', async () => {
    const targetRoot = await makeRoot('target-name-suffix')
    const sourceRoot = await makeRoot('source-name-suffix')
    const sourceLabel = path.basename(sourceRoot)
    await addSongList({
      root: targetRoot,
      parentName: 'House',
      playlistName: 'Favorites',
      fileName: 'target.mp3',
      content: 'target'
    })
    await addSongList({
      root: targetRoot,
      parentName: 'House',
      playlistName: `Favorites (from ${sourceLabel})`,
      fileName: 'target-suffixed.mp3',
      content: 'target-suffixed'
    })
    await addSongList({
      root: sourceRoot,
      parentName: 'House',
      playlistName: 'Favorites',
      fileName: 'source.mp3',
      content: 'source'
    })

    await mergeFrkbLibraries({ sourceRoot, targetRoot, mode: 'copy' })

    await expect(
      fs.readFile(
        path.join(
          targetRoot,
          'library',
          'FilterLibrary',
          'House',
          `Favorites (from ${sourceLabel}) 2`,
          'source.mp3'
        ),
        'utf8'
      )
    ).resolves.toBe('source')
  })

  it('merges an empty normal playlist without requiring a staged media file', async () => {
    const targetRoot = await makeRoot('target-empty-list')
    const sourceRoot = await makeRoot('source-empty-list')
    await addEmptySongList({ root: sourceRoot, parentName: 'Ambient', playlistName: 'Empty' })

    const result = await mergeFrkbLibraries({ sourceRoot, targetRoot, mode: 'copy' })

    expect(result.songListCount).toBe(1)
    await expect(
      fs.access(path.join(targetRoot, 'library', 'FilterLibrary', 'Ambient', 'Empty'))
    ).resolves.toBeUndefined()
  })

  it('migrates Set and Mixtape items with their custody and vault files', async () => {
    const targetRoot = await makeRoot('target-special')
    const sourceRoot = await makeRoot('source-special')
    const sourceSet = await addSetList({
      root: sourceRoot,
      playlistName: 'Warmup Set',
      fileName: 'set-track.wav',
      content: 'set-track'
    })
    const sourceMixtape = await addMixtapeList({
      root: sourceRoot,
      playlistName: 'Summer Mix',
      fileName: 'mix-track.wav',
      content: 'mix-track'
    })

    await mergeFrkbLibraries({ sourceRoot, targetRoot, mode: 'copy' })

    const db = openDb(targetRoot)
    try {
      const setNode = db
        .prepare('SELECT uuid FROM library_nodes WHERE dir_name = ?')
        .get('Warmup Set') as { uuid: string } | undefined
      const mixtapeNode = db
        .prepare('SELECT uuid FROM library_nodes WHERE dir_name = ?')
        .get('Summer Mix') as { uuid: string } | undefined
      expect(setNode?.uuid).toBeTruthy()
      expect(mixtapeNode?.uuid).toBeTruthy()
      expect(setNode?.uuid).not.toBe(sourceSet.playlistUuid)
      expect(mixtapeNode?.uuid).not.toBe(sourceMixtape.playlistUuid)

      const setItem = db
        .prepare('SELECT playlist_uuid, file_path, analysis_json FROM set_items')
        .get() as { playlist_uuid: string; file_path: string; analysis_json: string } | undefined
      expect(setItem?.playlist_uuid).toBe(setNode?.uuid)
      expect(setItem?.file_path).toBe(
        path.join(targetRoot, 'library', 'SetLibrary', '__set_custody__', 'set-track.wav')
      )
      expect(await fs.readFile(setItem?.file_path || '', 'utf8')).toBe('set-track')
      expect(JSON.parse(setItem?.analysis_json || '{}').bpm).toBe(124)

      const mixtapeItem = db
        .prepare('SELECT playlist_uuid, file_path, info_json FROM mixtape_items')
        .get() as { playlist_uuid: string; file_path: string; info_json: string } | undefined
      expect(mixtapeItem?.playlist_uuid).toBe(mixtapeNode?.uuid)
      expect(mixtapeItem?.file_path).toBe(
        path.join(targetRoot, 'library', 'MixtapeLibrary', '.mixtape_vault', 'mix-track.wav')
      )
      expect(await fs.readFile(mixtapeItem?.file_path || '', 'utf8')).toBe('mix-track')
      const mixtapeInfo = JSON.parse(mixtapeItem?.info_json || '{}') as Record<string, unknown>
      expect(mixtapeInfo.filePath).toBe(mixtapeItem?.file_path)
      expect(mixtapeInfo.stemStatus).toBe('pending')
      expect(mixtapeInfo.stemVocalPath).toBeUndefined()
      const project = db.prepare('SELECT playlist_uuid, info_json FROM mixtape_projects').get() as
        | { playlist_uuid: string; info_json: string }
        | undefined
      expect(project?.playlist_uuid).toBe(mixtapeNode?.uuid)
      expect(JSON.parse(project?.info_json || '{}').bpm).toBe(128)
      expect(db.pragma('foreign_key_check')).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('rejects malformed special-library content before creating target files', async () => {
    const targetRoot = await makeRoot('target-reject')
    const sourceRoot = await makeRoot('source-reject')
    const unsupportedFile = path.join(sourceRoot, 'library', 'MixtapeLibrary', 'project.mp3')
    await fs.writeFile(unsupportedFile, 'unsupported', 'utf8')

    await expect(
      mergeFrkbLibraries({ sourceRoot, targetRoot, appVersion: '1.2.1', mode: 'copy' })
    ).rejects.toMatchObject({ code: 'SOURCE_TREE_INVALID' })
    await expect(fs.access(path.join(targetRoot, '.frkb-merge'))).rejects.toThrow()
    await expect(
      fs.access(path.join(sourceRoot, 'library', 'MixtapeLibrary', 'project.mp3'))
    ).resolves.toBeUndefined()
  })

  it('rejects an unregistered target path before creating a rollback journal', async () => {
    const targetRoot = await makeRoot('target-orphan-path')
    const sourceRoot = await makeRoot('source-orphan-path')
    await addSongList({
      root: sourceRoot,
      parentName: 'Techno',
      playlistName: 'Incoming',
      fileName: 'source.mp3',
      content: 'source'
    })
    const orphanPath = path.join(targetRoot, 'library', 'FilterLibrary', 'Techno')
    await fs.mkdir(orphanPath, { recursive: true })
    await fs.writeFile(path.join(orphanPath, 'keep.mp3'), 'target-owned', 'utf8')

    await expect(
      mergeFrkbLibraries({ sourceRoot, targetRoot, mode: 'copy' })
    ).rejects.toMatchObject({ code: 'TARGET_TREE_INVALID' })
    expect(await fs.readFile(path.join(orphanPath, 'keep.mp3'), 'utf8')).toBe('target-owned')
    await expect(fs.access(path.join(targetRoot, '.frkb-merge'))).rejects.toThrow()
  })

  it('does not delete a source path that no longer has the journaled manifest identity', async () => {
    const targetRoot = await makeRoot('target-recovery-source-identity')
    const sourceRoot = await makeRoot('source-recovery-source-identity')
    const jobId = 'committed-source-identity-job'
    const db = openDb(targetRoot)
    try {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        `library_merge.${jobId}.committed`,
        '1'
      )
    } finally {
      db.close()
    }
    const sourceManifestPath = path.join(sourceRoot, 'FRKB.database.frkbdb')
    const sourceManifest = JSON.parse(await fs.readFile(sourceManifestPath, 'utf8')) as Record<
      string,
      unknown
    >
    sourceManifest.uuid = 'replacement-library-uuid'
    await fs.writeFile(sourceManifestPath, JSON.stringify(sourceManifest), 'utf8')
    const journalDir = path.join(targetRoot, '.frkb-merge', jobId)
    await fs.mkdir(journalDir, { recursive: true })
    await fs.writeFile(
      path.join(journalDir, 'journal.json'),
      JSON.stringify({
        version: 1,
        jobId,
        mode: 'delete-source',
        sourceRoot,
        targetRoot,
        sourceManifestUuid: 'original-library-uuid',
        targetManifestUuid: 'target',
        phase: 'deleting-source',
        promotionIntents: [],
        promotedRoots: [],
        directoryIntents: [],
        createdDirectories: [],
        fileHashes: {}
      })
    )

    await recoverIncompleteLibraryMerges(targetRoot)

    await expect(fs.access(sourceRoot)).resolves.toBeUndefined()
    await expect(fs.access(journalDir)).resolves.toBeUndefined()
  })

  it('refuses to begin when another target database writer already holds the write lock', async () => {
    const targetRoot = await makeRoot('target-db-lock')
    const sourceRoot = await makeRoot('source-db-lock')
    await addSongList({
      root: sourceRoot,
      parentName: 'House',
      playlistName: 'Incoming',
      fileName: 'track.mp3',
      content: 'track'
    })
    const blockingDb = openDb(targetRoot)
    blockingDb.pragma('busy_timeout = 1')
    blockingDb.exec('BEGIN IMMEDIATE')
    try {
      await expect(mergeFrkbLibraries({ sourceRoot, targetRoot, mode: 'copy' })).rejects.toThrow()
    } finally {
      blockingDb.exec('ROLLBACK')
      blockingDb.close()
    }
    await expect(
      fs.access(path.join(targetRoot, 'library', 'FilterLibrary', 'House', 'Incoming', 'track.mp3'))
    ).rejects.toThrow()
    await expect(
      fs.access(path.join(sourceRoot, 'library', 'FilterLibrary', 'House', 'Incoming'))
    ).resolves.toBeUndefined()
    await expect(fs.access(path.join(targetRoot, '.frkb-merge'))).rejects.toThrow()
  })

  it('rolls back promoted files when the target transaction fails', async () => {
    const targetRoot = await makeRoot('target-transaction-failure')
    const sourceRoot = await makeRoot('source-transaction-failure')
    await addSongList({
      root: sourceRoot,
      parentName: 'House',
      playlistName: 'Incoming',
      fileName: 'track.mp3',
      content: 'track'
    })
    const db = openDb(targetRoot)
    try {
      db.exec(`
        CREATE TRIGGER reject_library_merge_node
        BEFORE INSERT ON library_nodes
        WHEN NEW.parent_uuid IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'forced node insert failure');
        END;
      `)
    } finally {
      db.close()
    }

    await expect(mergeFrkbLibraries({ sourceRoot, targetRoot, mode: 'copy' })).rejects.toThrow(
      'forced node insert failure'
    )
    await expect(
      fs.access(path.join(targetRoot, 'library', 'FilterLibrary', 'House', 'Incoming'))
    ).rejects.toThrow()
    await expect(fs.access(path.join(targetRoot, '.frkb-merge'))).rejects.toThrow()
    await expect(
      fs.access(path.join(sourceRoot, 'library', 'FilterLibrary', 'House', 'Incoming', 'track.mp3'))
    ).resolves.toBeUndefined()
  })

  it('rolls back journaled promoted files when a prior merge did not commit', async () => {
    const targetRoot = await makeRoot('target-recovery')
    const promotedRoot = path.join(targetRoot, 'library', 'FilterLibrary', 'RecoveredList')
    await fs.mkdir(promotedRoot, { recursive: true })
    await fs.writeFile(path.join(promotedRoot, 'partial.mp3'), 'partial', 'utf8')
    const journalDir = path.join(targetRoot, '.frkb-merge', 'interrupted-job')
    await fs.mkdir(journalDir, { recursive: true })
    await fs.writeFile(
      path.join(journalDir, 'journal.json'),
      JSON.stringify({
        version: 1,
        jobId: 'interrupted-job',
        mode: 'copy',
        sourceRoot: '/source',
        targetRoot,
        sourceManifestUuid: 'source',
        targetManifestUuid: 'target',
        phase: 'promoting',
        promotionIntents: [promotedRoot],
        promotedRoots: [promotedRoot],
        directoryIntents: [],
        createdDirectories: [],
        fileHashes: {}
      })
    )
    await fs.writeFile(path.join(targetRoot, '.frkb-merge.lock'), 'interrupted-job\n')

    await recoverIncompleteLibraryMerges(targetRoot)

    await expect(fs.access(promotedRoot)).rejects.toThrow()
    await expect(fs.access(journalDir)).rejects.toThrow()
    await expect(fs.access(path.join(targetRoot, '.frkb-merge.lock'))).rejects.toThrow()
  })
})
