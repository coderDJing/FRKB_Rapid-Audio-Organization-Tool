import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CancellationToken, DownloadOptions, ProgressInfo } from 'builder-util-runtime'
import { CancellationError } from 'builder-util-runtime'
import type { OutgoingHttpHeaders } from 'node:http'
import { fetchWithSystemProxy } from '../fetchWithSystemProxy'
import {
  createResumableDownloadCacheKey,
  downloadResumableFile,
  ResumableDownloadAbortError,
  type ResumableDownloadFetch
} from './resumableHttpDownload'

type AutoUpdaterHttpExecutor = {
  download: (url: URL, destination: string, options: DownloadOptions) => Promise<string>
}

type AutoUpdaterWithHttpExecutor = {
  httpExecutor?: AutoUpdaterHttpExecutor | null
}

const UPDATE_PACKAGE_CACHE_DIRNAME = 'update-package-cache'

let resumableDownloadInstalled = false

const fetchWithProxy: ResumableDownloadFetch = async (url, init) => {
  const response = await fetchWithSystemProxy(url, {
    headers: init?.headers,
    signal: init?.signal
  })
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body: response.body
  }
}

const toHeaderRecord = (headers?: OutgoingHttpHeaders | null): Record<string, string> => {
  if (!headers) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value == null || key.toLowerCase() === 'range') continue
    result[key] = Array.isArray(value) ? value.join(',') : String(value)
  }
  return result
}

const getUpdatePackageCacheDir = () =>
  path.join(app.getPath('userData'), UPDATE_PACKAGE_CACHE_DIRNAME)

const cleanupOtherUpdatePackageCache = async (cacheDir: string, keepKey: string) => {
  const entries = await fs.readdir(cacheDir).catch(() => [] as string[])
  const keepName = `${keepKey}.part`
  await Promise.all(
    entries
      .filter((name) => name.endsWith('.part') && name !== keepName)
      .map((name) => fs.rm(path.join(cacheDir, name), { force: true }).catch(() => {}))
  )
}

const bindCancellation = (cancellationToken: CancellationToken) => {
  const controller = new AbortController()
  const onCancel = () => {
    if (!controller.signal.aborted) controller.abort()
  }
  if (cancellationToken.cancelled) {
    onCancel()
  } else {
    cancellationToken.on('cancel', onCancel)
  }
  return {
    signal: controller.signal,
    dispose: () => {
      cancellationToken.off('cancel', onCancel)
    }
  }
}

const toUpdaterProgress = (payload: {
  percent: number
  bytesPerSecond: number
  transferredBytes: number
  totalBytes: number
}): ProgressInfo => ({
  total: payload.totalBytes,
  delta: 0,
  transferred: payload.transferredBytes,
  percent: payload.percent,
  bytesPerSecond: payload.bytesPerSecond
})

export const installResumableAutoUpdaterDownload = (autoUpdater: object) => {
  if (resumableDownloadInstalled) return
  const executor = (autoUpdater as AutoUpdaterWithHttpExecutor).httpExecutor
  if (!executor || typeof executor.download !== 'function') return
  resumableDownloadInstalled = true

  executor.download = async (url, destination, options) => {
    const cancellation = bindCancellation(options.cancellationToken)
    try {
      if (options.cancellationToken.cancelled) {
        throw new CancellationError()
      }
      const cacheDir = getUpdatePackageCacheDir()
      await fs.mkdir(cacheDir, { recursive: true })
      const cacheKey = createResumableDownloadCacheKey({
        url: url.href,
        sha512: options.sha512,
        sha256: options.sha2
      })
      const cachePath = path.join(cacheDir, `${cacheKey}.part`)
      await cleanupOtherUpdatePackageCache(cacheDir, cacheKey)
      let lastTransferred = 0
      await downloadResumableFile(
        {
          url: url.href,
          destinationPath: cachePath,
          sha512: options.sha512,
          sha256: options.sha2,
          headers: toHeaderRecord(options.headers),
          signal: cancellation.signal,
          onProgress: (payload) => {
            const delta = Math.max(0, payload.transferredBytes - lastTransferred)
            lastTransferred = payload.transferredBytes
            options.onProgress?.({
              ...toUpdaterProgress(payload),
              delta
            })
          }
        },
        { fetch: fetchWithProxy }
      )
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(cachePath, destination)
      await fs.rm(cachePath, { force: true }).catch(() => {})
      return destination
    } catch (error) {
      if (error instanceof ResumableDownloadAbortError || options.cancellationToken.cancelled) {
        throw new CancellationError()
      }
      throw error
    } finally {
      cancellation.dispose()
    }
  }
}
