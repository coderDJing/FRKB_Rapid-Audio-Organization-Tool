import { createRequire } from 'node:module'
import process from 'node:process'

const require = createRequire(import.meta.url)
const native = require('../rust_package/index.js')

function readStdin() {
  return new Promise((resolve, reject) => {
    let source = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      source += chunk
    })
    process.stdin.on('end', () => resolve(source))
    process.stdin.on('error', reject)
  })
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

try {
  const request = JSON.parse(await readStdin())
  const paths = Array.isArray(request.paths) ? request.paths.map((item) => String(item)) : []
  const maxLengthSeconds = Number(request.maxLengthSeconds || 120)
  if (paths.length === 0) {
    throw new Error('audio identity request contains no paths')
  }
  if (
    typeof native.calculateAudioHashes !== 'function' ||
    typeof native.generateChromaprintFingerprint !== 'function'
  ) {
    throw new Error('required native audio identity exports are unavailable')
  }

  const pcmRows = native.calculateAudioHashes(paths)
  if (!Array.isArray(pcmRows) || pcmRows.length !== paths.length) {
    throw new Error('calculateAudioHashes returned an incomplete result')
  }
  const pcmByPath = new Map(pcmRows.map((item) => [String(item.filePath), item]))
  const tracks = paths.map((filePath) => {
    const pcm = pcmByPath.get(filePath)
    if (!pcm || pcm.error || !pcm.sha256Hash || pcm.sha256Hash === 'error') {
      throw new Error(`PCM hash failed for ${filePath}: ${pcm?.error || 'missing result'}`)
    }
    const chromaprint = native.generateChromaprintFingerprint(filePath, maxLengthSeconds)
    if (chromaprint?.error || !chromaprint?.fingerprint) {
      throw new Error(
        `Chromaprint failed for ${filePath}: ${chromaprint?.error || 'missing fingerprint'}`
      )
    }
    return {
      filePath,
      pcmSha256: String(pcm.sha256Hash),
      fingerprint: String(chromaprint.fingerprint),
      duration: Number(chromaprint.duration || 0)
    }
  })
  process.stdout.write(`${JSON.stringify({ tracks })}\n`)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
