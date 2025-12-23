import { app } from 'electron'
import crypto from 'crypto'
import fs = require('fs-extra')
import path = require('path')

type OpenL3Manifest = {
  schemaVersion: number
  modelVersion: string
  modelFile: string
  sha256?: string
  embeddingDim?: number
  sampleRate?: number
}

const ENV_MODEL_PATH = 'FRKB_OPENL3_MODEL_PATH'
const ENV_MODEL_VERSION = 'FRKB_OPENL3_MODEL_VERSION'

const OPENL3_SUBDIR = path.join('ai', 'openl3')
const MANIFEST_FILE = 'manifest.json'

function resolveBundledOpenL3Dir(): string {
  const base = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../../resources')
  return path.join(base, OPENL3_SUBDIR)
}

function resolveUserOpenL3Dir(): string {
  const base = app.getPath('userData')
  return path.join(base, OPENL3_SUBDIR)
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function readManifest(dir: string): Promise<OpenL3Manifest | null> {
  try {
    const manifestPath = path.join(dir, MANIFEST_FILE)
    if (!(await fs.pathExists(manifestPath))) return null
    const raw = await fs.readJSON(manifestPath)
    if (!raw || typeof raw !== 'object') return null
    const schemaVersion = Number(raw.schemaVersion || 0)
    const modelVersion = typeof raw.modelVersion === 'string' ? raw.modelVersion.trim() : ''
    const modelFile = typeof raw.modelFile === 'string' ? raw.modelFile.trim() : ''
    const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : ''
    const embeddingDim =
      typeof raw.embeddingDim === 'number' && Number.isFinite(raw.embeddingDim)
        ? raw.embeddingDim
        : undefined
    const sampleRate =
      typeof raw.sampleRate === 'number' && Number.isFinite(raw.sampleRate)
        ? raw.sampleRate
        : undefined
    if (!schemaVersion || !modelVersion || !modelFile) return null
    return {
      schemaVersion,
      modelVersion,
      modelFile,
      sha256: sha256 || undefined,
      embeddingDim,
      sampleRate
    }
  } catch {
    return null
  }
}

export async function ensureOpenL3ModelReady(): Promise<{
  modelPath: string
  modelVersion: string
} | null> {
  const override = process.env[ENV_MODEL_PATH]
  if (override && override.trim().length > 0) {
    const p = override.trim()
    if (await fs.pathExists(p)) {
      return { modelPath: p, modelVersion: process.env[ENV_MODEL_VERSION] || '' }
    }
  }

  const bundledDir = resolveBundledOpenL3Dir()
  const manifest = await readManifest(bundledDir)
  if (!manifest) return null

  const bundledModelPath = path.join(bundledDir, manifest.modelFile)
  if (!(await fs.pathExists(bundledModelPath))) return null

  const userDir = resolveUserOpenL3Dir()
  const userModelPath = path.join(userDir, manifest.modelFile)

  try {
    await fs.ensureDir(userDir)

    const needsCopy = !(await fs.pathExists(userModelPath))
    if (!needsCopy && manifest.sha256) {
      try {
        const current = await sha256File(userModelPath)
        if (current !== manifest.sha256) {
          await fs.copy(bundledModelPath, userModelPath, { overwrite: true })
        }
      } catch {
        await fs.copy(bundledModelPath, userModelPath, { overwrite: true })
      }
    } else if (needsCopy) {
      await fs.copy(bundledModelPath, userModelPath, { overwrite: true })
    }

    process.env[ENV_MODEL_PATH] = userModelPath
    process.env[ENV_MODEL_VERSION] = manifest.modelVersion
    return { modelPath: userModelPath, modelVersion: manifest.modelVersion }
  } catch {
    return null
  }
}
