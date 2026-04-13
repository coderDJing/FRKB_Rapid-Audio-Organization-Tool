import fs = require('fs-extra')
import path = require('path')

type ErrorLike = {
  code?: unknown
  message?: unknown
}

export type InterruptedDecision = 'resume' | 'cancel'

export const collectFilesWithExtensions = async (dir: string, extensions: string[] = []) => {
  let files: string[] = []
  try {
    const stats = await fs.stat(dir)

    if (stats.isFile()) {
      const ext = path.extname(dir).toLowerCase()
      if (extensions.includes(ext)) {
        return [dir]
      }
      return []
    }

    const directoryEntries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of directoryEntries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isFile()) {
        const ext = path.extname(fullPath).toLowerCase()
        if (extensions.includes(ext)) {
          files.push(fullPath)
        }
      } else if (entry.isDirectory()) {
        const subFiles = await collectFilesWithExtensions(fullPath, extensions)
        files = files.concat(subFiles)
      }
    }

    return files
  } catch {
    return []
  }
}

export function isENOSPCError(error: unknown): boolean {
  try {
    const err = (error && typeof error === 'object' ? error : null) as ErrorLike | null
    const code = err?.code || ''
    const message = err?.message || ''
    return (
      String(code).toUpperCase() === 'ENOSPC' || /no space left on device/i.test(String(message))
    )
  } catch {
    return false
  }
}

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  options: {
    concurrency?: number
    onProgress?: (done: number, total: number) => void
    onInterrupted?: (payload: {
      total: number
      done: number
      running: number
      pending: number
      successSoFar: number
      failedSoFar: number
    }) => Promise<InterruptedDecision>
    stopOnENOSPC?: boolean
    yieldEvery?: number
  } = {}
): Promise<{
  results: Array<T | Error>
  success: number
  failed: number
  hasENOSPC: boolean
  skipped: number
}> {
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 16))
  const yieldEvery = Math.max(0, Math.floor(options.yieldEvery ?? 0))
  const total = tasks.length
  const results: Array<T | Error> = new Array(total)
  let nextIndex = 0
  let inFlight = 0
  let completed = 0
  let hasENOSPC = false
  let interrupted = false
  let cancelled = false
  let skipped = 0

  const retryQueue: number[] = []

  let gateResolve: (() => void) | null = null
  let gate: Promise<void> | null = null
  const closeGate = () => {
    if (gateResolve) gateResolve()
    gateResolve = null
    gate = null
  }
  const openGate = () => {
    if (!gate) {
      gate = new Promise<void>((resolve) => {
        gateResolve = resolve
      })
    }
  }

  const maybeYieldToEventLoop = async () => {
    if (yieldEvery <= 0 || completed === 0 || completed % yieldEvery !== 0) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  const getNextTaskIndex = async (): Promise<number | null> => {
    if (cancelled) return null
    if (interrupted && gate) {
      await gate
      if (cancelled) return null
    }
    if (retryQueue.length > 0) {
      return retryQueue.shift() as number
    }
    if (nextIndex < total) {
      const idx = nextIndex
      nextIndex += 1
      return idx
    }
    return null
  }

  async function handleENOSPC(idx: number) {
    hasENOSPC = true
    retryQueue.push(idx)
    if (options.stopOnENOSPC !== false) {
      if (!interrupted) {
        interrupted = true
        openGate()
        if (typeof options.onInterrupted === 'function') {
          const successSoFar = results.filter(
            (result) => result !== undefined && !(result instanceof Error)
          ).length
          const failedSoFar = results.filter((result) => result instanceof Error).length
          const decision = await options.onInterrupted({
            total,
            done: completed,
            running: inFlight,
            pending: total - completed - inFlight,
            successSoFar,
            failedSoFar
          })
          if (decision === 'resume') {
            interrupted = false
            closeGate()
          } else {
            cancelled = true
            skipped += total - completed - inFlight
            closeGate()
          }
        }
      }
    }
  }

  async function worker() {
    while (true) {
      const idx = await getNextTaskIndex()
      if (idx === null) break
      inFlight += 1
      try {
        const value = await tasks[idx]()
        results[idx] = value === undefined ? (true as unknown as T) : value
        completed += 1
        options.onProgress?.(completed, total)
        await maybeYieldToEventLoop()
      } catch (error: unknown) {
        if (isENOSPCError(error)) {
          await handleENOSPC(idx)
          if (cancelled) {
            results[idx] = error instanceof Error ? error : new Error(String(error))
            completed += 1
            options.onProgress?.(completed, total)
            await maybeYieldToEventLoop()
          }
        } else {
          results[idx] = error instanceof Error ? error : new Error(String(error))
          completed += 1
          options.onProgress?.(completed, total)
          await maybeYieldToEventLoop()
        }
      } finally {
        inFlight -= 1
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker())
  await Promise.all(workers)

  const failed = results.filter((result) => result instanceof Error).length
  const success = results.filter(
    (result) => result !== undefined && !(result instanceof Error)
  ).length
  return { results, success, failed, hasENOSPC, skipped }
}
