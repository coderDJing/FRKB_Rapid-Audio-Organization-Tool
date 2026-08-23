import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  downloadResumableFile,
  downloadedFileMatchesChecksum,
  shouldRetryResumableDownload,
  ResumableDownloadChecksumError,
  ResumableDownloadHttpError,
  type ResumableDownloadFetch,
  type ResumableDownloadFetchInit,
  type ResumableDownloadResponse
} from './resumableHttpDownload'

const payload = Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789')

const sha512Of = (buffer: Buffer) => createHash('sha512').update(buffer).digest('base64')

const parseRangeStart = (headers?: ResumableDownloadFetchInit['headers']) => {
  const range = headers?.Range || ''
  const match = range.match(/^bytes=(\d+)-/i)
  return match ? Number(match[1]) : 0
}

const createResponse = (
  status: number,
  buffer: Buffer,
  extraHeaders: Record<string, string> = {}
): ResumableDownloadResponse => {
  const headers: Record<string, string> = {
    'content-length': String(buffer.length),
    ...extraHeaders
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[name.toLowerCase()] || null
    },
    body: Readable.from([buffer])
  }
}

const createRangeFetch = (source: Buffer): ResumableDownloadFetch => {
  return async (_url, init) => {
    const start = parseRangeStart(init?.headers)
    const slice = source.subarray(start)
    if (start <= 0) {
      return createResponse(200, slice)
    }
    return createResponse(206, slice, {
      'content-range': `bytes ${start}-${source.length - 1}/${source.length}`
    })
  }
}

describe('downloadResumableFile', () => {
  const dirs: string[] = []

  const createTempFile = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'frkb-resume-'))
    dirs.push(dir)
    return path.join(dir, 'update.bin')
  }

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('能从半截文件续传剩余字节', async () => {
    const destinationPath = await createTempFile()
    await writeFile(destinationPath, payload.subarray(0, 10))
    const ranges: string[] = []
    const progress: Array<{ transferredBytes: number; totalBytes: number; percent: number }> = []
    const fetch: ResumableDownloadFetch = async (_url, init) => {
      ranges.push(init?.headers?.Range || '')
      return createRangeFetch(payload)(_url, init)
    }

    await downloadResumableFile(
      {
        url: 'https://example.test/update.bin',
        destinationPath,
        expectedSize: payload.length,
        sha512: sha512Of(payload),
        maxAttempts: 1,
        onProgress: (snapshot) => progress.push(snapshot)
      },
      { fetch }
    )

    expect(ranges).toEqual(['bytes=10-'])
    expect(progress[0]).toEqual({
      transferredBytes: 10,
      totalBytes: payload.length,
      percent: (10 / payload.length) * 100,
      bytesPerSecond: expect.any(Number)
    })
    expect(progress.at(-1)?.transferredBytes).toBe(payload.length)
    expect(await readFile(destinationPath)).toEqual(payload)
  })

  it('中途失败时保留半截文件，下次从断点继续', async () => {
    const destinationPath = await createTempFile()
    let calls = 0
    const fetch: ResumableDownloadFetch = async (_url, init) => {
      calls += 1
      const start = parseRangeStart(init?.headers)
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name) => (name.toLowerCase() === 'content-length' ? String(payload.length) : null)
          },
          body: Readable.from(
            (async function* () {
              yield payload.subarray(0, 12)
              throw new Error('socket hang up')
            })()
          )
        }
      }
      expect(start).toBe(12)
      return createRangeFetch(payload)(_url, init)
    }

    await downloadResumableFile(
      {
        url: 'https://example.test/update.bin',
        destinationPath,
        expectedSize: payload.length,
        sha512: sha512Of(payload),
        maxAttempts: 2,
        retryDelayMs: 0
      },
      { fetch }
    )

    expect(calls).toBe(2)
    expect(await readFile(destinationPath)).toEqual(payload)
  })

  it('服务器忽略 Range 返回 200 时会整包重下', async () => {
    const destinationPath = await createTempFile()
    await writeFile(destinationPath, payload.subarray(0, 8))
    const fetch: ResumableDownloadFetch = async (_url, init) => {
      const start = parseRangeStart(init?.headers)
      expect(start).toBe(8)
      return createResponse(200, payload)
    }

    await downloadResumableFile(
      {
        url: 'https://example.test/update.bin',
        destinationPath,
        expectedSize: payload.length,
        sha512: sha512Of(payload),
        maxAttempts: 1
      },
      { fetch }
    )

    expect(await readFile(destinationPath)).toEqual(payload)
  })

  it('完整且校验通过的文件会直接复用', async () => {
    const destinationPath = await createTempFile()
    await writeFile(destinationPath, payload)
    let calls = 0
    const fetch: ResumableDownloadFetch = async () => {
      calls += 1
      throw new Error('should not fetch')
    }

    await downloadResumableFile(
      {
        url: 'https://example.test/update.bin',
        destinationPath,
        expectedSize: payload.length,
        sha512: sha512Of(payload),
        maxAttempts: 1
      },
      { fetch }
    )

    expect(calls).toBe(0)
    expect((await stat(destinationPath)).size).toBe(payload.length)
  })

  it('校验失败会删除文件并报错', async () => {
    const destinationPath = await createTempFile()
    const fetch = createRangeFetch(payload)

    await expect(
      downloadResumableFile(
        {
          url: 'https://example.test/update.bin',
          destinationPath,
          expectedSize: payload.length,
          sha512: sha512Of(Buffer.from('not-the-payload')),
          maxAttempts: 1
        },
        { fetch }
      )
    ).rejects.toBeInstanceOf(ResumableDownloadChecksumError)

    await expect(stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('不知道总大小时半截文件会直接 Range 续传', async () => {
    const destinationPath = await createTempFile()
    await writeFile(destinationPath, payload.subarray(0, 10))
    const ranges: string[] = []
    const fetch: ResumableDownloadFetch = async (_url, init) => {
      ranges.push(init?.headers?.Range || '')
      return createRangeFetch(payload)(_url, init)
    }

    await downloadResumableFile(
      {
        url: 'https://example.test/update.bin',
        destinationPath,
        sha512: sha512Of(payload),
        maxAttempts: 1
      },
      { fetch }
    )

    expect(ranges).toEqual(['bytes=10-'])
    expect(await readFile(destinationPath)).toEqual(payload)
  })

  it('不知道总大小时完整文件会发 Range，416 后再校验复用', async () => {
    const destinationPath = await createTempFile()
    await writeFile(destinationPath, payload)
    const ranges: string[] = []
    const fetch: ResumableDownloadFetch = async (_url, init) => {
      ranges.push(init?.headers?.Range || '')
      return {
        ok: false,
        status: 416,
        headers: { get: () => null },
        body: Readable.from([])
      }
    }

    await downloadResumableFile(
      {
        url: 'https://example.test/update.bin',
        destinationPath,
        sha512: sha512Of(payload),
        maxAttempts: 1
      },
      { fetch }
    )

    expect(ranges).toEqual([`bytes=${payload.length}-`])
    expect(await readFile(destinationPath)).toEqual(payload)
  })

  it('安装包 404 会删除半截文件且不再续传', async () => {
    const destinationPath = await createTempFile()
    await writeFile(destinationPath, payload.subarray(0, 10))
    const fetch: ResumableDownloadFetch = async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      body: Readable.from([])
    })

    await expect(
      downloadResumableFile(
        {
          url: 'https://example.test/update.bin',
          destinationPath,
          expectedSize: payload.length,
          sha512: sha512Of(payload),
          maxAttempts: 1
        },
        { fetch }
      )
    ).rejects.toMatchObject({ statusCode: 404 })

    await expect(stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('downloadedFileMatchesChecksum', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('有 sha512 时必须内容一致才算通过', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'frkb-resume-hash-'))
    dirs.push(dir)
    const filePath = path.join(dir, 'update.bin')
    await writeFile(filePath, payload)
    expect(await downloadedFileMatchesChecksum(filePath, { sha512: sha512Of(payload) })).toBe(true)
    expect(
      await downloadedFileMatchesChecksum(filePath, {
        sha512: sha512Of(Buffer.from('not-the-payload'))
      })
    ).toBe(false)
  })
})

describe('shouldRetryResumableDownload', () => {
  it('网络类错误和 403/429 会重试，404 与校验失败不会', () => {
    expect(shouldRetryResumableDownload(new Error('socket hang up'))).toBe(true)
    expect(shouldRetryResumableDownload(new ResumableDownloadHttpError(403, 'rate limited'))).toBe(
      true
    )
    expect(shouldRetryResumableDownload(new ResumableDownloadHttpError(429, 'too many'))).toBe(true)
    expect(shouldRetryResumableDownload(new ResumableDownloadHttpError(404, 'missing'))).toBe(false)
    expect(shouldRetryResumableDownload(new ResumableDownloadChecksumError('bad hash'))).toBe(false)
  })
})
