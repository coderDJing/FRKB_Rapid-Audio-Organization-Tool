import { runCuratedLibrarySync } from './engine'
import type { CuratedLibrarySyncStartPayload } from '../../shared/curatedLibrarySync'

let queued: Promise<unknown> = Promise.resolve()

export const enqueueCloudWork = async <T>(task: () => Promise<T>): Promise<T> => {
  const run = queued.then(task, task)
  queued = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export const enqueueCuratedLibrarySync = (
  payload?: CuratedLibrarySyncStartPayload
): Promise<Awaited<ReturnType<typeof runCuratedLibrarySync>>> =>
  enqueueCloudWork(() => runCuratedLibrarySync(payload))
