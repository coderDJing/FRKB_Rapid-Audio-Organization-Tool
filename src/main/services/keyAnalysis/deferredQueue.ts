import type {
  KeyAnalysisJob,
  KeyAnalysisPriority,
  KeyAnalysisQueueCategory,
  KeyAnalysisRequestFlags,
  KeyAnalysisSource
} from './types'

type DeferredRequestOptions = KeyAnalysisRequestFlags & {
  fastAnalysis?: boolean
  preemptible?: boolean
  category?: KeyAnalysisQueueCategory
  waveformOnly?: boolean
  includeStructure?: boolean
}

type DeferredQueueHelpers = {
  nextJobId: () => number
  isHigherPriority: (next: KeyAnalysisPriority, current: KeyAnalysisPriority) => boolean
  applyQueueCategory: (job: KeyAnalysisJob, category?: KeyAnalysisQueueCategory) => void
  applyWaveformOnlyOption: (job: KeyAnalysisJob, waveformOnly?: boolean) => void
  applyIncludeStructureOption: (job: KeyAnalysisJob, includeStructure?: boolean) => void
  applyRequestFlags: (job: KeyAnalysisJob, flags: KeyAnalysisRequestFlags) => void
  addManualBatchIdsToJob: (job: KeyAnalysisJob, batchIds: string[]) => void
  addFocusSlotToJob: (job: KeyAnalysisJob, focusSlot?: string) => void
  removeManualBatchIdFromJob: (job: KeyAnalysisJob, batchId: string) => boolean
  isManualOnlyJob: (job: KeyAnalysisJob) => boolean
}

export class KeyAnalysisDeferredQueue {
  private jobsByPath = new Map<string, KeyAnalysisJob>()

  get size() {
    return this.jobsByPath.size
  }

  has(normalizedPath: string) {
    return this.jobsByPath.has(normalizedPath)
  }

  get(normalizedPath: string) {
    return this.jobsByPath.get(normalizedPath)
  }

  delete(normalizedPath: string) {
    return this.jobsByPath.delete(normalizedPath)
  }

  requiresFollowUp(active: KeyAnalysisJob, options: DeferredRequestOptions) {
    const requiresStructureUpgrade =
      options.includeStructure === true && active.includeStructure !== true
    const requiresFullAnalysisUpgrade =
      options.waveformOnly !== true && active.waveformOnly === true
    const requiresForcedAnalysisUpgrade =
      options.forceAnalysis === true && active.forceAnalysis !== true
    return requiresStructureUpgrade || requiresFullAnalysisUpgrade || requiresForcedAnalysisUpgrade
  }

  defer(
    active: KeyAnalysisJob,
    priority: KeyAnalysisPriority,
    source: KeyAnalysisSource,
    options: DeferredRequestOptions,
    focusSlot: string,
    manualBatchIds: string[],
    helpers: DeferredQueueHelpers
  ) {
    const existing = this.jobsByPath.get(active.normalizedPath)
    if (existing) {
      if (helpers.isHigherPriority(priority, existing.priority)) {
        existing.priority = priority
        existing.source = source
        if (options.fastAnalysis !== undefined) existing.fastAnalysis = options.fastAnalysis
        if (options.preemptible !== undefined) existing.preemptible = options.preemptible
      }
      helpers.applyQueueCategory(existing, options.category)
      helpers.applyWaveformOnlyOption(existing, options.waveformOnly)
      helpers.applyIncludeStructureOption(existing, options.includeStructure)
      helpers.applyRequestFlags(existing, options)
      helpers.addManualBatchIdsToJob(existing, manualBatchIds)
      helpers.addFocusSlotToJob(existing, focusSlot)
      return
    }

    const deferred: KeyAnalysisJob = {
      jobId: helpers.nextJobId(),
      filePath: active.filePath,
      normalizedPath: active.normalizedPath,
      priority,
      fastAnalysis: options.fastAnalysis ?? false,
      source,
      preemptible: options.preemptible === true,
      category: options.category,
      waveformOnly: options.waveformOnly === true,
      includeStructure: options.includeStructure === true,
      forceAnalysis: options.forceAnalysis === true,
      manualBatchIds: manualBatchIds.length ? manualBatchIds : undefined
    }
    helpers.addFocusSlotToJob(deferred, focusSlot)
    this.jobsByPath.set(active.normalizedPath, deferred)
  }

  promote(
    isBlocked: (normalizedPath: string) => boolean,
    addPending: (job: KeyAnalysisJob) => void
  ) {
    for (const [normalizedPath, job] of Array.from(this.jobsByPath.entries())) {
      if (isBlocked(normalizedPath)) continue
      this.jobsByPath.delete(normalizedPath)
      addPending(job)
    }
  }

  removeManualBatch(batchId: string, helpers: DeferredQueueHelpers) {
    for (const [normalizedPath, job] of Array.from(this.jobsByPath.entries())) {
      if (!helpers.removeManualBatchIdFromJob(job, batchId)) continue
      if (!job.manualBatchIds && helpers.isManualOnlyJob(job)) {
        this.jobsByPath.delete(normalizedPath)
      }
    }
  }

  clearBackground() {
    for (const [normalizedPath, job] of Array.from(this.jobsByPath.entries())) {
      if (job.priority === 'background') this.jobsByPath.delete(normalizedPath)
    }
  }

  clearAll() {
    this.jobsByPath.clear()
  }

  hasForegroundWork() {
    for (const job of this.jobsByPath.values()) {
      if (job.source === 'foreground') return true
    }
    return false
  }

  remap(
    fromNormalizedPath: string,
    toNormalizedPath: string,
    rebindJobPath: (job: KeyAnalysisJob) => void,
    helpers: DeferredQueueHelpers
  ) {
    const deferredJob = this.jobsByPath.get(fromNormalizedPath)
    if (!deferredJob) return
    this.jobsByPath.delete(fromNormalizedPath)
    rebindJobPath(deferredJob)
    const existing = this.jobsByPath.get(toNormalizedPath)
    if (!existing) {
      this.jobsByPath.set(toNormalizedPath, deferredJob)
      return
    }
    helpers.applyIncludeStructureOption(existing, deferredJob.includeStructure)
    helpers.applyWaveformOnlyOption(existing, deferredJob.waveformOnly)
    helpers.applyQueueCategory(existing, deferredJob.category)
    helpers.applyRequestFlags(existing, deferredJob)
    helpers.addManualBatchIdsToJob(existing, deferredJob.manualBatchIds || [])
    for (const focusSlot of deferredJob.focusSlots || []) {
      helpers.addFocusSlotToJob(existing, focusSlot)
    }
  }
}
