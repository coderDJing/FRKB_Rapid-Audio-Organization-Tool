import test from 'ava'

import * as native from '../index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('native exports', (t) => {
  t.is(typeof native.calculateAudioHashes, 'function')
  t.is(typeof native.calculateAudioHashesWithProgress, 'function')
  t.is(typeof native.calculateFileHashes, 'function')
  t.is(typeof native.calculateFileHashesWithProgress, 'function')
  t.is(typeof native.decodeAudioFile, 'function')
  t.is(typeof native.decodeAudioFileLimited, 'function')
  t.is(typeof native.upsertSongFeatures, 'function')
  t.is(typeof native.extractOpenL3Embedding, 'function')
  t.is(typeof native.setSelectionLabels, 'function')
  t.is(typeof native.getSelectionLabelSnapshot, 'function')
  t.is(typeof native.resetSelectionSampleChangeCount, 'function')
  t.is(typeof native.resetSelectionLabels, 'function')
  t.is(typeof native.getSelectionFeatureStatus, 'function')
  t.is(typeof native.getSelectionLabel, 'function')
  t.is(typeof native.bumpSelectionSampleChangeCount, 'function')
  t.is(typeof native.deleteSelectionPredictionCache, 'function')
  t.is(typeof native.trainSelectionGbdt, 'function')
  t.is(typeof native.predictSelectionCandidates, 'function')
})

test('selection labels db basic flow', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb_selection_labels_'))
  try {
    t.is(native.getSelectionLabel(tmpDir, 'missing'), 'neutral')

    const snap0 = native.getSelectionLabelSnapshot(tmpDir)
    t.deepEqual(snap0.positiveIds, [])
    t.deepEqual(snap0.negativeIds, [])
    t.is(snap0.sampleChangeCount, 0)

    const r1 = native.setSelectionLabels(tmpDir, ['a', 'b', 'a'], 'liked')
    t.is(r1.total, 2)
    t.is(r1.changed, 2)
    t.is(r1.sampleChangeCount, 2)

    const snap1 = native.getSelectionLabelSnapshot(tmpDir)
    t.deepEqual(snap1.positiveIds, ['a', 'b'])
    t.deepEqual(snap1.negativeIds, [])
    t.is(snap1.sampleChangeCount, 2)

    const r2 = native.setSelectionLabels(tmpDir, ['b'], 'disliked')
    t.is(r2.changed, 1)
    t.is(r2.sampleChangeCount, 3)

    t.is(native.getSelectionLabel(tmpDir, 'a'), 'liked')
    t.is(native.getSelectionLabel(tmpDir, 'b'), 'disliked')

    const snap2 = native.getSelectionLabelSnapshot(tmpDir)
    t.deepEqual(snap2.positiveIds, ['a'])
    t.deepEqual(snap2.negativeIds, ['b'])
    t.is(snap2.sampleChangeCount, 3)

    t.is(native.bumpSelectionSampleChangeCount(tmpDir, 2), 5)
    t.is(native.bumpSelectionSampleChangeCount(tmpDir, -3), 2)
    t.is(native.bumpSelectionSampleChangeCount(tmpDir, -999), 0)

    const r3 = native.setSelectionLabels(tmpDir, ['a'], 'neutral')
    t.is(r3.changed, 1)
    t.is(r3.sampleChangeCount, 1)

    const snap3 = native.getSelectionLabelSnapshot(tmpDir)
    t.deepEqual(snap3.positiveIds, [])
    t.deepEqual(snap3.negativeIds, ['b'])
    t.is(snap3.sampleChangeCount, 1)

    const r4 = native.setSelectionLabels(tmpDir, ['b'], 'neutral')
    t.is(r4.changed, 1)
    t.is(r4.sampleChangeCount, 2)

    native.resetSelectionSampleChangeCount(tmpDir)
    const snap4 = native.getSelectionLabelSnapshot(tmpDir)
    t.is(snap4.sampleChangeCount, 0)

    const okReset = native.resetSelectionLabels(tmpDir)
    t.is(okReset, true)
    const snap5 = native.getSelectionLabelSnapshot(tmpDir)
    t.deepEqual(snap5.positiveIds, [])
    t.deepEqual(snap5.negativeIds, [])
    t.is(snap5.sampleChangeCount, 0)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('selection features db basic flow', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb_selection_features_'))
  try {
    const songId = 'song1'
    const affected1 = native.upsertSongFeatures(tmpDir, [
      {
        songId,
        fileHash: songId,
        modelVersion: 'selection_features_v1',
        rmsMean: 0.123,
        bpm: 128.5,
        key: 'C',
        durationSec: 180.2,
        bitrateKbps: 320,
        chromaprintFingerprint: '1,2,3,4,5'
      }
    ])
    t.true(affected1 >= 1)

    const status1 = native.getSelectionFeatureStatus(tmpDir, [songId])
    t.is(status1.length, 1)
    t.is(status1[0].songId, songId)
    t.is(status1[0].hasFeatures, true)

    // 空 patch 不应覆盖已有特征（COALESCE 逻辑）
    const affected2 = native.upsertSongFeatures(tmpDir, [
      { songId, fileHash: songId, modelVersion: 'selection_features_v1' }
    ])
    t.true(affected2 >= 1)

    const status2 = native.getSelectionFeatureStatus(tmpDir, [songId])
    t.is(status2[0].hasFeatures, true)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
