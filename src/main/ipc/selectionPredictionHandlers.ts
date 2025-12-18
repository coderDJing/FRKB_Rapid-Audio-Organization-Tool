import { ipcMain } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { log } from '../log'
import store from '../store'
import { buildSelectionSongFeaturePatches } from '../services/selectionFeatureExtractor'
import { resolveSelectionSongIds } from '../services/selectionSongIdResolver'
import { runWithConcurrency } from '../utils'
import mainWindow from '../window/mainWindow'
import {
  clearSelectionPredictionCache,
  deleteSelectionPredictionCache,
  getSelectionFeatureStatus,
  getSelectionLabelSnapshot,
  predictSelectionCandidates,
  resetSelectionLabels,
  resetSelectionSampleChangeCount,
  setSelectionLabels,
  trainSelectionGbdt,
  upsertSongFeatures
} from 'rust_package'

type Failed = { errorCode: string; message?: string }

const AUTO_TRAIN_DEBOUNCE_MS = 8000
const AUTO_TRAIN_SAMPLE_CHANGE_THRESHOLD = 20
const AUTO_TRAIN_MIN_POSITIVE = 20
const AUTO_TRAIN_NEGATIVE_RATIO = 4

const FEATURE_EXTRACT_CONCURRENCY = 2
const FEATURE_ENSURE_QUEUE_CONCURRENCY = 1
const LABEL_SET_CONCURRENCY = 2
const LABEL_SET_DEFAULT_MAX_ANALYZE_SECONDS = 120

let autoTrainTimer: NodeJS.Timeout | null = null
let autoTrainInFlight = false
let autoTrainQueued = false
let autoTrainDbDir: string | null = null

type QueuedTask<T> = {
  id: number
  queuedAt: number
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason: any) => void
}

let labelSetSeq = 0
let labelSetInFlight = 0
const labelSetQueue: Array<QueuedTask<any>> = []

let featureEnsureSeq = 0
let featureEnsureInFlight = 0
const featureEnsureQueue: Array<QueuedTask<any>> = []
const featureEnsurePendingSongIds = new Set<string>()

function enqueueLabelSetTask<T>(run: () => Promise<T>): Promise<T> {
  const id = (labelSetSeq += 1)
  const queuedAt = Date.now()
  return new Promise<T>((resolve, reject) => {
    labelSetQueue.push({ id, queuedAt, run, resolve, reject })
    log.debug(
      `[selection] labels:setForFilePaths 已加入队列 id=${id} 排队=${labelSetQueue.length} 并发中=${labelSetInFlight} 并发上限=${LABEL_SET_CONCURRENCY}`
    )
    void drainLabelSetQueue()
  })
}

async function drainLabelSetQueue() {
  while (labelSetInFlight < LABEL_SET_CONCURRENCY && labelSetQueue.length > 0) {
    const task = labelSetQueue.shift() as QueuedTask<any>
    labelSetInFlight += 1
    const waitMs = Date.now() - task.queuedAt
    log.debug(
      `[selection] labels:setForFilePaths 开始执行 id=${task.id} 排队等待=${waitMs}ms 排队=${labelSetQueue.length} 并发中=${labelSetInFlight}/${LABEL_SET_CONCURRENCY}`
    )
    task
      .run()
      .then(task.resolve, task.reject)
      .finally(() => {
        labelSetInFlight -= 1
        log.debug(
          `[selection] labels:setForFilePaths 执行结束 id=${task.id} 排队=${labelSetQueue.length} 并发中=${labelSetInFlight}/${LABEL_SET_CONCURRENCY}`
        )
        void drainLabelSetQueue()
      })
  }
}

function enqueueFeatureEnsureTask<T>(run: () => Promise<T>): Promise<T> {
  const id = (featureEnsureSeq += 1)
  const queuedAt = Date.now()
  return new Promise<T>((resolve, reject) => {
    featureEnsureQueue.push({ id, queuedAt, run, resolve, reject })
    log.debug(
      `[selection] features:ensure 已加入队列 id=${id} 排队=${featureEnsureQueue.length} 并发中=${featureEnsureInFlight} 并发上限=${FEATURE_ENSURE_QUEUE_CONCURRENCY}`
    )
    void drainFeatureEnsureQueue()
  })
}

async function drainFeatureEnsureQueue() {
  while (
    featureEnsureInFlight < FEATURE_ENSURE_QUEUE_CONCURRENCY &&
    featureEnsureQueue.length > 0
  ) {
    const task = featureEnsureQueue.shift() as QueuedTask<any>
    featureEnsureInFlight += 1
    const waitMs = Date.now() - task.queuedAt
    log.debug(
      `[selection] features:ensure 开始执行 id=${task.id} 排队等待=${waitMs}ms 排队=${featureEnsureQueue.length} 并发中=${featureEnsureInFlight}/${FEATURE_ENSURE_QUEUE_CONCURRENCY}`
    )
    task
      .run()
      .then(task.resolve, task.reject)
      .finally(() => {
        featureEnsureInFlight -= 1
        log.debug(
          `[selection] features:ensure 执行结束 id=${task.id} 排队=${featureEnsureQueue.length} 并发中=${featureEnsureInFlight}/${FEATURE_ENSURE_QUEUE_CONCURRENCY}`
        )
        void drainFeatureEnsureQueue()
      })
  }
}

async function ensureSelectionFeaturesForItems(
  featureStorePath: string,
  items: Array<{ songId: string; filePath: string; fileHash: string }>,
  options?: { maxAnalyzeSeconds?: number; logLabel?: string }
): Promise<{
  ok: boolean
  total: number
  extracted: number
  skipped: number
  affected: number
  report: any[]
  failed?: Failed
}> {
  const startedAt = Date.now()
  const logLabel = options?.logLabel || 'features:ensure'
  const maxAnalyzeSeconds = options?.maxAnalyzeSeconds

  try {
    const songIds = items.map((x) => x.songId)
    log.debug(
      `[selection] ${logLabel} 开始 songs=${items.length} 最大分析秒数=${String(maxAnalyzeSeconds ?? '')}`
    )

    let statusList: Array<{ songId: string; hasFeatures: boolean }> = []
    try {
      statusList = getSelectionFeatureStatus(featureStorePath, songIds) as any
    } catch (error) {
      log.warn('[selection] 读取特征状态失败', error)
      // 如果无法判断，保守认为都缺失，交由提取流程兜底
      statusList = []
    }

    const hasById = new Map<string, boolean>()
    for (const it of statusList) {
      const id = typeof (it as any)?.songId === 'string' ? String((it as any).songId) : ''
      if (!id) continue
      hasById.set(id, Boolean((it as any).hasFeatures))
    }

    const pending = items.filter((x) => hasById.get(x.songId) !== true)
    if (pending.length === 0) {
      log.debug(`[selection] ${logLabel} 无需处理（全部已就绪，${Date.now() - startedAt}ms）`)
      return {
        ok: true,
        total: items.length,
        extracted: 0,
        skipped: items.length,
        affected: 0,
        report: []
      }
    }

    const tasks = pending.map((x) => async (): Promise<{ patch: any; report: any }> => {
      try {
        const { patches, report } = await buildSelectionSongFeaturePatches(
          [{ songId: x.songId, filePath: x.filePath, fileHash: x.fileHash }],
          { maxAnalyzeSeconds }
        )
        return { patch: patches?.[0], report: report?.[0] }
      } catch (error: any) {
        return {
          patch: { songId: x.songId, fileHash: x.fileHash, modelVersion: 'selection_features_v1' },
          report: {
            songId: x.songId,
            filePath: x.filePath,
            ok: false,
            error: String(error?.message || error)
          }
        }
      }
    })

    const { results } = await runWithConcurrency(tasks, {
      concurrency: FEATURE_EXTRACT_CONCURRENCY
    })

    const patches: any[] = []
    const report: any[] = []
    const touchedIds = new Set<string>()

    for (const r of results) {
      if (r instanceof Error) {
        report.push({ ok: false, error: String((r as any)?.message || r) })
        continue
      }
      if (r?.patch) {
        patches.push(r.patch)
        if (typeof r.patch.songId === 'string') touchedIds.add(r.patch.songId)
      }
      if (r?.report) {
        report.push(r.report)
      }
    }

    const affected = patches.length ? upsertSongFeatures(featureStorePath, patches) : 0

    // 特征补齐后，清理这些 songId 的预测缓存，避免继续命中“缺特征时”的旧分数
    if (touchedIds.size > 0) {
      try {
        deleteSelectionPredictionCache(featureStorePath, Array.from(touchedIds))
      } catch (error) {
        log.warn('[selection] 清理预测缓存失败', error)
      }
    }

    try {
      const okCount = report.filter((x: any) => x?.ok === true).length
      const openl3Ok = report.filter((x: any) => x?.openl3 === 'ok').length
      const openl3Skipped = report.filter((x: any) => x?.openl3 === 'skipped').length
      const openl3Failed = report.filter((x: any) => x?.openl3 === 'failed').length
      log.info(
        `[selection] ${logLabel} 完成 (${Date.now() - startedAt}ms) 总数=${items.length} 提取=${pending.length} 入库=${affected} 成功=${okCount}/${report.length} openl3(成功/跳过/失败)=${openl3Ok}/${openl3Skipped}/${openl3Failed}`
      )

      if (openl3Failed > 0) {
        const samples = report
          .filter((x: any) => x?.openl3 === 'failed')
          .slice(0, 3)
          .map((x: any) => ({
            filePath: x?.filePath,
            openl3Error: x?.openl3Error || x?.error || 'UNKNOWN'
          }))
        log.warn('[selection] openl3 失败样例', samples)
      }
    } catch {}

    return {
      ok: true,
      total: items.length,
      extracted: pending.length,
      skipped: items.length - pending.length,
      affected,
      report
    }
  } catch (error: any) {
    log.error(`[selection] ${logLabel} 失败`, error)
    return {
      ok: false,
      total: 0,
      extracted: 0,
      skipped: 0,
      affected: 0,
      report: [],
      failed: { errorCode: 'internal_error', message: String(error?.message || error) } as Failed
    }
  }
}

function scheduleSelectionFeatureEnsureForItems(
  dbDir: string,
  items: Array<{ songId: string; filePath: string; fileHash: string }>,
  options?: { maxAnalyzeSeconds?: number; reason?: string }
): { enqueued: number; skipped: number } {
  if (!dbDir) return { enqueued: 0, skipped: 0 }
  const uniqueById = new Map<string, { songId: string; filePath: string; fileHash: string }>()
  for (const it of items) {
    if (!it?.songId) continue
    if (!uniqueById.has(it.songId)) uniqueById.set(it.songId, it)
  }
  const uniqueItems = Array.from(uniqueById.values())

  const pending = uniqueItems.filter((it) => !featureEnsurePendingSongIds.has(it.songId))
  const skipped = uniqueItems.length - pending.length
  if (pending.length === 0) {
    log.debug(`[selection] 特征提取已在队列中；无需重复安排（原因=${options?.reason || ''}）`)
    return { enqueued: 0, skipped }
  }

  for (const it of pending) featureEnsurePendingSongIds.add(it.songId)

  void enqueueFeatureEnsureTask(async () => {
    try {
      // 若任务在队列中等待期间切库，直接取消（避免写入到错误的库）
      if (!store.databaseDir || store.databaseDir !== dbDir) {
        return
      }
      const featureStorePath = path.join(dbDir, 'features.db')
      await ensureSelectionFeaturesForItems(featureStorePath, pending, {
        maxAnalyzeSeconds: options?.maxAnalyzeSeconds,
        logLabel: 'features:ensure(后台)'
      })
    } finally {
      for (const it of pending) featureEnsurePendingSongIds.delete(it.songId)
    }
  }).catch(() => {})

  log.debug(
    `[selection] 已安排后台特征提取：入队=${pending.length} 跳过=${skipped}（原因=${options?.reason || ''}）`
  )
  return { enqueued: pending.length, skipped }
}

function resolveSelectionModelPaths(dbDir: string): { modelPath: string; manifestPath: string } {
  const modelDir = path.join(dbDir, 'models', 'selection')
  return {
    modelPath: path.join(modelDir, 'selection_gbdt_v1.bin'),
    manifestPath: path.join(modelDir, 'manifest.json')
  }
}

function scheduleAutoTrain(dbDir: string) {
  autoTrainDbDir = dbDir
  const wasScheduled = Boolean(autoTrainTimer)
  if (autoTrainTimer) clearTimeout(autoTrainTimer)
  autoTrainTimer = setTimeout(() => {
    autoTrainTimer = null
    void runAutoTrain(dbDir)
  }, AUTO_TRAIN_DEBOUNCE_MS)
  log.debug(
    `[selection] 自动训练${wasScheduled ? '已重新安排' : '已安排'}（防抖=${AUTO_TRAIN_DEBOUNCE_MS}ms）`
  )
}

function emitAutoTrainEvent(payload: any) {
  try {
    mainWindow.instance?.webContents.send('selection:autoTrainStatus', payload)
  } catch {}
}

export function notifySelectionSamplesChanged(
  dbDir: string,
  options?: { sampleChangeCount?: number; reason?: string }
) {
  if (!dbDir || !store.databaseDir || store.databaseDir !== dbDir) return
  log.debug(
    `[selection] 样本已变更：安排自动训练（原因=${options?.reason || ''}，样本变更计数=${String(
      options?.sampleChangeCount ?? ''
    )})`
  )
  scheduleAutoTrain(dbDir)
  emitAutoTrainEvent({
    status: 'scheduled',
    debounceMs: AUTO_TRAIN_DEBOUNCE_MS,
    sampleChangeCount: options?.sampleChangeCount,
    reason: options?.reason
  })
}

async function runAutoTrain(dbDir: string) {
  if (autoTrainInFlight) {
    autoTrainQueued = true
    log.debug('[selection] 自动训练进行中；已加入队列')
    return
  }

  if (!dbDir || !store.databaseDir || store.databaseDir !== dbDir) return

  autoTrainInFlight = true
  try {
    const snapshot = getSelectionLabelSnapshot(dbDir)
    if (snapshot.sampleChangeCount < AUTO_TRAIN_SAMPLE_CHANGE_THRESHOLD) {
      log.debug(
        `[selection] 自动训练已跳过：样本变更不足（${snapshot.sampleChangeCount}/${AUTO_TRAIN_SAMPLE_CHANGE_THRESHOLD}）`
      )
      emitAutoTrainEvent({
        status: 'skipped',
        reason: 'insufficient_sample_changes',
        sampleChangeCount: snapshot.sampleChangeCount,
        threshold: AUTO_TRAIN_SAMPLE_CHANGE_THRESHOLD
      })
      return
    }

    const pos = snapshot.positiveIds.length
    const neg = snapshot.negativeIds.length
    if (pos < AUTO_TRAIN_MIN_POSITIVE) {
      log.debug(
        `[selection] 自动训练已跳过：正样本不足（pos=${pos}, min=${AUTO_TRAIN_MIN_POSITIVE}）`
      )
      emitAutoTrainEvent({
        status: 'skipped',
        reason: 'insufficient_positive',
        positiveCount: pos,
        negativeCount: neg,
        minPositive: AUTO_TRAIN_MIN_POSITIVE
      })
      return
    }
    if (neg < AUTO_TRAIN_NEGATIVE_RATIO * pos) {
      log.debug(
        `[selection] 自动训练已跳过：负样本不足（pos=${pos}, neg=${neg}, ratio=${AUTO_TRAIN_NEGATIVE_RATIO}）`
      )
      emitAutoTrainEvent({
        status: 'skipped',
        reason: 'insufficient_negative',
        positiveCount: pos,
        negativeCount: neg,
        negativeRatio: AUTO_TRAIN_NEGATIVE_RATIO
      })
      return
    }

    if (featureEnsureInFlight > 0 || featureEnsureQueue.length > 0) {
      log.debug(
        `[selection] 自动训练等待特征提取完成：排队=${featureEnsureQueue.length} 并发中=${featureEnsureInFlight}/${FEATURE_ENSURE_QUEUE_CONCURRENCY}`
      )
      emitAutoTrainEvent({
        status: 'waiting_features',
        reason: 'features_pending',
        queueLength: featureEnsureQueue.length,
        inFlight: featureEnsureInFlight
      })
      scheduleAutoTrain(dbDir)
      return
    }

    emitAutoTrainEvent({
      status: 'running',
      sampleChangeCount: snapshot.sampleChangeCount,
      positiveCount: pos,
      negativeCount: neg
    })

    const featureStorePath = path.join(dbDir, 'features.db')
    const startedAt = Date.now()
    const res = trainSelectionGbdt(snapshot.positiveIds, snapshot.negativeIds, featureStorePath)
    if (res?.status === 'trained') {
      try {
        resetSelectionSampleChangeCount(dbDir)
      } catch (e) {
        log.warn('[selection] 重置 sampleChangeCount 失败', e)
      }
    }

    log.info(
      `[selection] 自动训练结束：状态=${String((res as any)?.status || 'unknown')}（${Date.now() - startedAt}ms）`
    )
    emitAutoTrainEvent({ ...res, sampleChangeCount: snapshot.sampleChangeCount })
  } catch (error: any) {
    log.error('[selection] 自动训练失败', error)
    emitAutoTrainEvent({
      status: 'failed',
      failed: { errorCode: 'internal_error', message: String(error?.message || error) } as Failed
    })
  } finally {
    autoTrainInFlight = false
    if (autoTrainQueued) {
      autoTrainQueued = false
      const nextDbDir = autoTrainDbDir
      if (nextDbDir) scheduleAutoTrain(nextDbDir)
    }
  }
}

export function registerSelectionPredictionHandlers() {
  ipcMain.handle('selection:training:reset', async () => {
    try {
      if (!store.databaseDir) throw new Error('NO_DB')
      if (autoTrainTimer) {
        clearTimeout(autoTrainTimer)
        autoTrainTimer = null
      }

      const { modelPath, manifestPath } = resolveSelectionModelPaths(store.databaseDir)

      const resetLabelsOk = resetSelectionLabels(store.databaseDir)
      resetSelectionSampleChangeCount(store.databaseDir)

      let clearedPredictionCache = 0
      try {
        const featureStorePath = path.join(store.databaseDir, 'features.db')
        clearedPredictionCache = clearSelectionPredictionCache(featureStorePath)
      } catch (e) {
        log.warn('[selection] 清空预测缓存失败', e)
      }

      let removedModel = false
      let removedManifest = false
      try {
        if (await fs.pathExists(modelPath)) {
          await fs.remove(modelPath)
          removedModel = true
        }
      } catch (e) {
        log.warn('[selection] 删除模型文件失败', e)
      }
      try {
        if (await fs.pathExists(manifestPath)) {
          await fs.remove(manifestPath)
          removedManifest = true
        }
      } catch (e) {
        log.warn('[selection] 删除 manifest 失败', e)
      }

      log.info(
        `[selection] 训练数据重置完成：重置标签=${resetLabelsOk} 清空预测缓存=${clearedPredictionCache} 删除模型文件=${removedModel} 删除manifest=${removedManifest}`
      )
      emitAutoTrainEvent({
        status: 'reset',
        reason: 'training_data_cleared'
      })
      return {
        ok: true,
        resetLabels: resetLabelsOk,
        clearedPredictionCache,
        removedModel,
        removedManifest
      }
    } catch (error: any) {
      log.error('[selection] 训练数据重置失败', error)
      return {
        ok: false,
        failed: { errorCode: 'internal_error', message: String(error?.message || error) } as Failed
      }
    }
  })

  ipcMain.handle('selection:labels:set', async (_e, payload: any) => {
    try {
      if (!store.databaseDir) throw new Error('NO_DB')
      const songIds = Array.isArray(payload?.songIds) ? payload.songIds.map(String) : []
      const label = typeof payload?.label === 'string' ? payload.label : ''
      const res = setSelectionLabels(store.databaseDir, songIds, label)
      if (res.sampleChangeDelta > 0) {
        scheduleAutoTrain(store.databaseDir)
        emitAutoTrainEvent({
          status: 'scheduled',
          debounceMs: AUTO_TRAIN_DEBOUNCE_MS,
          sampleChangeCount: res.sampleChangeCount
        })
      }
      return { ok: true, ...res }
    } catch (error: any) {
      log.error('[selection] 设置标签失败', error)
      return {
        ok: false,
        failed: { errorCode: 'db_error', message: String(error?.message || error) } as Failed
      }
    }
  })

  ipcMain.handle('selection:labels:setForFilePaths', async (_e, payload: any) => {
    const dbDir = store.databaseDir
    if (!dbDir) {
      return {
        ok: false,
        labelResult: null,
        hashReport: [],
        failed: { errorCode: 'internal_error', message: 'NO_DB' } as Failed
      }
    }

    const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths.map(String) : []
    const label = typeof payload?.label === 'string' ? payload.label : ''

    return enqueueLabelSetTask(async () => {
      // 若任务在队列中等待期间切库，直接取消（避免写入到错误的库）
      if (!store.databaseDir || store.databaseDir !== dbDir) {
        return {
          ok: false,
          labelResult: null,
          hashReport: [],
          failed: { errorCode: 'cancelled', message: '库已切换，任务已取消' } as Failed
        }
      }

      try {
        const startedAt = Date.now()
        log.info(`[selection] labels:setForFilePaths 开始 标签=${label} 文件数=${filePaths.length}`)

        const step1At = Date.now()
        log.debug('[selection] labels:setForFilePaths 步骤1/2 计算歌曲ID（PCM SHA256）开始')
        const { items, report: hashReport } = await resolveSelectionSongIds(filePaths, { dbDir })
        log.debug(
          `[selection] labels:setForFilePaths 步骤1/2 计算歌曲ID完成 items=${items.length}/${filePaths.length} (${Date.now() - step1At}ms)`
        )
        const songIds = items.map((x) => x.songId)

        const maxAnalyzeSeconds =
          typeof payload?.maxAnalyzeSeconds === 'number' && payload.maxAnalyzeSeconds > 0
            ? payload.maxAnalyzeSeconds
            : LABEL_SET_DEFAULT_MAX_ANALYZE_SECONDS

        const step2At = Date.now()
        log.debug(
          `[selection] labels:setForFilePaths 步骤2/2 写入标签开始 songIds=${songIds.length}`
        )
        const res = setSelectionLabels(dbDir, songIds, label)
        log.debug(
          `[selection] labels:setForFilePaths 步骤2/2 写入标签完成 (${Date.now() - step2At}ms)`
        )

        // 特征提取放到后台队列，避免阻塞 UI；仅对 liked/disliked 触发（neutral 无需补齐）
        const shouldEnsureFeatures = label === 'liked' || label === 'disliked'
        const featureQueue =
          shouldEnsureFeatures && items.length
            ? scheduleSelectionFeatureEnsureForItems(
                dbDir,
                items.map((x) => ({
                  songId: x.songId,
                  filePath: x.filePath,
                  fileHash: x.fileHash
                })),
                { maxAnalyzeSeconds, reason: `label:${label}` }
              )
            : { enqueued: 0, skipped: 0 }

        if (res.sampleChangeDelta > 0) {
          scheduleAutoTrain(dbDir)
          emitAutoTrainEvent({
            status: 'scheduled',
            debounceMs: AUTO_TRAIN_DEBOUNCE_MS,
            sampleChangeCount: res.sampleChangeCount
          })
        } else {
          log.debug('[selection] labels:setForFilePaths 标签未变化；跳过自动训练调度')
        }

        try {
          const hashOk = (hashReport || []).filter((x: any) => x?.ok === true).length
          log.info(
            `[selection] labels:setForFilePaths 完成 (${Date.now() - startedAt}ms) 解析=${items.length}/${filePaths.length} 哈希通过=${hashOk}/${hashReport.length} 特征提取(已入队/跳过)=${featureQueue.enqueued}/${featureQueue.skipped} 样本变更增量=${res.sampleChangeDelta} 样本变更计数=${res.sampleChangeCount}`
          )
        } catch {}

        return {
          ok: true,
          labelResult: res,
          hashReport,
          featureQueue
        }
      } catch (error: any) {
        log.error('[selection] labels:setForFilePaths 失败', error)
        return {
          ok: false,
          labelResult: null,
          hashReport: [],
          featureQueue: { enqueued: 0, skipped: 0 },
          failed: {
            errorCode: 'internal_error',
            message: String(error?.message || error)
          } as Failed
        }
      }
    })
  })

  ipcMain.handle('selection:labels:snapshot', async () => {
    try {
      if (!store.databaseDir) throw new Error('NO_DB')
      const res = getSelectionLabelSnapshot(store.databaseDir)
      return { ok: true, ...res }
    } catch (error: any) {
      log.error('[selection] 读取标签快照失败', error)
      return {
        ok: false,
        positiveIds: [],
        negativeIds: [],
        sampleChangeCount: 0,
        failed: { errorCode: 'db_error', message: String(error?.message || error) } as Failed
      }
    }
  })

  ipcMain.handle('selection:labels:reset', async () => {
    try {
      if (!store.databaseDir) throw new Error('NO_DB')
      const ok = resetSelectionLabels(store.databaseDir)
      return { ok: true, reset: ok }
    } catch (error: any) {
      log.error('[selection] 重置标签失败', error)
      return {
        ok: false,
        reset: false,
        failed: { errorCode: 'db_error', message: String(error?.message || error) } as Failed
      }
    }
  })

  ipcMain.handle('selection:upsertSongFeatures', async (_e, payload: any) => {
    try {
      if (!store.databaseDir) throw new Error('NO_DB')
      const featureStorePath = path.join(store.databaseDir, 'features.db')
      const items = Array.isArray(payload?.items) ? payload.items : []
      const affected = upsertSongFeatures(featureStorePath, items)
      return { ok: true, affected }
    } catch (error: any) {
      log.error('[selection] 写入特征失败', error)
      return {
        ok: false,
        affected: 0,
        failed: { errorCode: 'internal_error', message: String(error?.message || error) } as Failed
      }
    }
  })

  ipcMain.handle('selection:features:extractAndUpsert', async (_e, payload: any) => {
    try {
      if (!store.databaseDir) throw new Error('NO_DB')
      const featureStorePath = path.join(store.databaseDir, 'features.db')
      const items = Array.isArray(payload?.items) ? payload.items : []
      const { patches, report } = await buildSelectionSongFeaturePatches(items)
      const affected = upsertSongFeatures(featureStorePath, patches)
      return { ok: true, affected, report }
    } catch (error: any) {
      log.error('[selection] 提取并写入特征失败', error)
      return {
        ok: false,
        affected: 0,
        report: [],
        failed: { errorCode: 'internal_error', message: String(error?.message || error) } as Failed
      }
    }
  })

  ipcMain.handle('selection:features:ensureForFilePaths', async (_e, payload: any) => {
    const dbDir = store.databaseDir
    if (!dbDir) {
      return {
        ok: false,
        total: 0,
        extracted: 0,
        skipped: 0,
        affected: 0,
        hashReport: [],
        report: [],
        failed: { errorCode: 'internal_error', message: 'NO_DB' } as Failed
      }
    }

    const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths.map(String) : []
    const maxAnalyzeSeconds =
      typeof payload?.maxAnalyzeSeconds === 'number' && payload.maxAnalyzeSeconds > 0
        ? payload.maxAnalyzeSeconds
        : undefined

    return enqueueFeatureEnsureTask(async () => {
      // 若任务在队列中等待期间切库，直接取消（避免写入到错误的库）
      if (!store.databaseDir || store.databaseDir !== dbDir) {
        return {
          ok: false,
          total: 0,
          extracted: 0,
          skipped: 0,
          affected: 0,
          hashReport: [],
          report: [],
          failed: { errorCode: 'cancelled', message: '库已切换，任务已取消' } as Failed
        }
      }

      try {
        const { items, report: hashReport } = await resolveSelectionSongIds(filePaths, { dbDir })
        const featureStorePath = path.join(dbDir, 'features.db')

        const ensured = await ensureSelectionFeaturesForItems(
          featureStorePath,
          items.map((x) => ({ songId: x.songId, filePath: x.filePath, fileHash: x.fileHash })),
          { maxAnalyzeSeconds, logLabel: 'features:ensureForFilePaths' }
        )
        return { ...ensured, hashReport }
      } catch (error: any) {
        log.error('[selection] features:ensureForFilePaths 失败', error)
        return {
          ok: false,
          total: 0,
          extracted: 0,
          skipped: 0,
          affected: 0,
          hashReport: [],
          report: [],
          failed: {
            errorCode: 'internal_error',
            message: String(error?.message || error)
          } as Failed
        }
      }
    })
  })

  ipcMain.handle('selection:train', async (_e, payload: any) => {
    try {
      if (!store.databaseDir) throw new Error('NO_DB')
      const featureStorePath = path.join(store.databaseDir, 'features.db')
      const positiveIds = Array.isArray(payload?.positiveIds) ? payload.positiveIds.map(String) : []
      const negativeIds = Array.isArray(payload?.negativeIds) ? payload.negativeIds.map(String) : []
      return trainSelectionGbdt(positiveIds, negativeIds, featureStorePath)
    } catch (error: any) {
      log.error('[selection] 训练模型失败', error)
      return {
        status: 'failed',
        modelRevision: null,
        modelPath: null,
        failed: { errorCode: 'internal_error', message: String(error?.message || error) } as Failed
      }
    }
  })

  ipcMain.handle('selection:trainFromLabels', async () => {
    try {
      if (!store.databaseDir) throw new Error('NO_DB')
      const featureStorePath = path.join(store.databaseDir, 'features.db')
      const snapshot = getSelectionLabelSnapshot(store.databaseDir)
      const res = trainSelectionGbdt(snapshot.positiveIds, snapshot.negativeIds, featureStorePath)
      if (res?.status === 'trained') {
        try {
          resetSelectionSampleChangeCount(store.databaseDir)
        } catch (e) {
          log.warn('[selection] 重置 sampleChangeCount 失败', e)
        }
      }
      return { ...res, sampleChangeCount: snapshot.sampleChangeCount }
    } catch (error: any) {
      log.error('[selection] 从标签训练模型失败', error)
      return {
        status: 'failed',
        modelRevision: null,
        modelPath: null,
        sampleChangeCount: 0,
        failed: { errorCode: 'internal_error', message: String(error?.message || error) } as Failed
      }
    }
  })

  ipcMain.handle('selection:predict', async (_e, payload: any) => {
    try {
      if (!store.databaseDir) throw new Error('NO_DB')
      const featureStorePath = path.join(store.databaseDir, 'features.db')
      const candidateIds = Array.isArray(payload?.candidateIds)
        ? payload.candidateIds.map(String)
        : []
      const modelPath = payload?.modelPath ? String(payload.modelPath) : undefined
      const topK = typeof payload?.topK === 'number' ? payload.topK : undefined
      return predictSelectionCandidates(candidateIds, featureStorePath, modelPath, topK)
    } catch (error: any) {
      log.error('[selection] 预测失败', error)
      return {
        status: 'failed',
        modelRevision: null,
        items: null,
        failed: { errorCode: 'internal_error', message: String(error?.message || error) } as Failed
      }
    }
  })

  ipcMain.handle('selection:predictForFilePaths', async (_e, payload: any) => {
    try {
      const dbDir = store.databaseDir
      if (!dbDir) throw new Error('NO_DB')
      const featureStorePath = path.join(dbDir, 'features.db')
      const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths.map(String) : []
      const topK = typeof payload?.topK === 'number' ? payload.topK : undefined

      const startedAt = Date.now()
      log.debug(
        `[selection] predictForFilePaths 开始 文件数=${filePaths.length} 前K=${String(topK ?? '')}`
      )

      const { items, report: hashReport } = await resolveSelectionSongIds(filePaths, { dbDir })
      const candidateIds = items.map((x) => x.songId)

      // 标签展示：优先使用快照，避免 per-song 反复查询；若 labels db 不存在则不创建，保持“未标记”为空
      let likedSet = new Set<string>()
      let dislikedSet = new Set<string>()
      try {
        const labelDbPath = path.join(dbDir, 'selection_labels.db')
        if (await fs.pathExists(labelDbPath)) {
          const snap = getSelectionLabelSnapshot(dbDir)
          likedSet = new Set(
            Array.isArray((snap as any)?.positiveIds) ? (snap as any).positiveIds : []
          )
          dislikedSet = new Set(
            Array.isArray((snap as any)?.negativeIds) ? (snap as any).negativeIds : []
          )
        }
      } catch (error) {
        log.warn('[selection] 读取标签快照失败', error)
        likedSet = new Set()
        dislikedSet = new Set()
      }

      // 没有音频特征的候选不参与推理（避免“缺特征时”的无意义分数与缓存）
      let readySet = new Set<string>()
      try {
        const statusList = getSelectionFeatureStatus(featureStorePath, candidateIds) as any
        for (const it of statusList || []) {
          const id = typeof it?.songId === 'string' ? it.songId : ''
          if (!id) continue
          if (it?.hasFeatures) readySet.add(id)
        }
      } catch (error) {
        log.warn('[selection] 读取特征状态失败', error)
        readySet = new Set()
      }

      const readyIds = candidateIds.filter((id) => readySet.has(id))
      const res = predictSelectionCandidates(readyIds, featureStorePath, undefined, topK)

      try {
        const status = typeof (res as any)?.status === 'string' ? (res as any).status : 'unknown'
        log.debug(
          `[selection] predictForFilePaths 完成 状态=${status} 可预测=${readyIds.length}/${candidateIds.length} (${Date.now() - startedAt}ms)`
        )
      } catch {}
      const scoreById = new Map<string, number>()
      const list = Array.isArray((res as any)?.items) ? ((res as any).items as any[]) : []
      for (const it of list) {
        const id = typeof it?.id === 'string' ? it.id : ''
        const score = typeof it?.score === 'number' ? it.score : null
        if (id && score !== null) scoreById.set(id, score)
      }

      return {
        ...res,
        affected: 0,
        hashReport,
        fileItems: items.map((x) => ({
          filePath: x.filePath,
          songId: x.songId,
          score: readySet.has(x.songId) ? (scoreById.get(x.songId) ?? null) : null,
          label: likedSet.has(x.songId)
            ? 'liked'
            : dislikedSet.has(x.songId)
              ? 'disliked'
              : 'neutral'
        }))
      }
    } catch (error: any) {
      log.error('[selection] predictForFilePaths 失败', error)
      return {
        status: 'failed',
        modelRevision: null,
        items: null,
        affected: 0,
        hashReport: [],
        fileItems: [],
        failed: { errorCode: 'internal_error', message: String(error?.message || error) } as Failed
      }
    }
  })
}
