import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

const args = process.argv.slice(2)
const releaseRuntime = args.includes('--release-runtime')
const forwardedArgs = args.filter((arg) => arg !== '--release-runtime')

const releaseRuntimeRoot = 'vendor/demucs-release'
const env = {
  ...process.env
}

const ensureArgs = [path.resolve('./scripts/ensure-demucs-runtime.mjs')]
if (releaseRuntime) {
  env.FRKB_DEMUCS_ROOT = releaseRuntimeRoot
  ensureArgs.push(
    '--runtime-root',
    releaseRuntimeRoot,
    '--prefer-remote-assets',
    '--sync-remote-assets',
    '--strict'
  )
}

const ensureResult = spawnSync(process.execPath, ensureArgs, {
  stdio: 'inherit',
  windowsHide: false,
  env
})

if ((ensureResult.status ?? 1) !== 0) {
  process.exit(ensureResult.status ?? 1)
}

const electronViteCliPath = path.resolve('./node_modules/electron-vite/bin/electron-vite.js')
const child = spawn(process.execPath, [electronViteCliPath, 'dev', ...forwardedArgs], {
  stdio: 'inherit',
  windowsHide: false,
  env
})

child.once('error', (error) => {
  console.error(
    `[frkb-dev] Failed to start electron-vite dev: ${
      error instanceof Error ? error.message : String(error || 'unknown')
    }`
  )
  process.exit(1)
})

child.once('exit', (code, signal) => {
  if (typeof code === 'number') {
    process.exit(code)
  }
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(0)
})
