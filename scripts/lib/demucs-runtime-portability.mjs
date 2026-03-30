import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const DARWIN_RUNTIME_INSPECT_TIMEOUT_MS = 12_000
const DARWIN_SYSTEM_LIBRARY_PREFIXES = ['/System/Library/', '/usr/lib/']

const normalizeResolvedPath = (value) => {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    return path.resolve(text)
  } catch {
    return ''
  }
}

const isPathInside = (rootDir, targetPath) => {
  const normalizedRoot = normalizeResolvedPath(rootDir)
  const normalizedTarget = normalizeResolvedPath(targetPath)
  if (!normalizedRoot || !normalizedTarget) return false
  const relativePath = path.relative(normalizedRoot, normalizedTarget)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

const toErrorText = (value, maxLen = 600) => {
  const text = String(value || '').trim()
  if (!text) return ''
  return text.length <= maxLen ? text : text.slice(0, maxLen)
}

const inspectDarwinRuntimeIdentity = ({ pythonPath, runtimeDir, env }) => {
  const script = [
    'import json',
    'import os',
    'import sys',
    'payload = {',
    '  "executable": os.path.abspath(sys.executable),',
    '  "prefix": os.path.abspath(sys.prefix),',
    '  "base_prefix": os.path.abspath(getattr(sys, "base_prefix", sys.prefix)),',
    '  "base_exec_prefix": os.path.abspath(getattr(sys, "base_exec_prefix", getattr(sys, "base_prefix", sys.prefix)))',
    '}',
    'print(json.dumps(payload))'
  ].join('\n')
  const result = spawnSync(pythonPath, ['-c', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: DARWIN_RUNTIME_INSPECT_TIMEOUT_MS,
    env
  })
  if (result.status !== 0) {
    return {
      ok: false,
      payload: null,
      error: toErrorText(result.stderr || result.stdout || `inspect exit ${result.status ?? -1}`)
    }
  }
  const output = String(result.stdout || '')
  const lastLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  if (!lastLine) {
    return {
      ok: false,
      payload: null,
      error: 'inspect output empty'
    }
  }
  try {
    const payload = JSON.parse(lastLine)
    return {
      ok: true,
      payload,
      error: ''
    }
  } catch (error) {
    return {
      ok: false,
      payload: null,
      error: toErrorText(error instanceof Error ? error.message : String(error || ''))
    }
  }
}

const inspectDarwinBinaryDependencies = ({ binaryPath }) => {
  const result = spawnSync('otool', ['-L', binaryPath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: DARWIN_RUNTIME_INSPECT_TIMEOUT_MS
  })
  if (result.status !== 0) {
    return {
      ok: false,
      dependencies: [],
      error: toErrorText(result.stderr || result.stdout || `otool exit ${result.status ?? -1}`)
    }
  }
  const dependencies = String(result.stdout || '')
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\s+\(compatibility version[\s\S]*$/, '').trim())
    .filter(Boolean)
  return {
    ok: true,
    dependencies,
    error: ''
  }
}

const inspectDarwinRuntimeSymlinks = ({ runtimeDir }) => {
  const issues = []
  const visitDir = (currentDir) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name)
      const relativePath = path.relative(runtimeDir, entryPath).replace(/\\/g, '/')
      const stat = fs.lstatSync(entryPath)
      if (stat.isSymbolicLink()) {
        let rawTarget = ''
        try {
          rawTarget = fs.readlinkSync(entryPath)
        } catch (error) {
          issues.push(
            `${relativePath} -> <unreadable> (${toErrorText(
              error instanceof Error ? error.message : String(error || 'unknown')
            )})`
          )
          continue
        }
        const normalizedTarget = String(rawTarget || '').trim()
        if (!normalizedTarget) {
          issues.push(`${relativePath} -> <empty>`)
          continue
        }
        if (path.isAbsolute(normalizedTarget)) {
          issues.push(`${relativePath} -> ${normalizedTarget} (absolute symlink)`)
          continue
        }
        const resolvedTarget = path.resolve(path.dirname(entryPath), normalizedTarget)
        if (!isPathInside(runtimeDir, resolvedTarget)) {
          issues.push(`${relativePath} -> ${normalizedTarget} (escapes runtime root)`)
          continue
        }
        if (!fs.existsSync(resolvedTarget)) {
          issues.push(`${relativePath} -> ${normalizedTarget} (missing target)`)
        }
        continue
      }
      if (stat.isDirectory()) {
        visitDir(entryPath)
      }
    }
  }

  try {
    visitDir(runtimeDir)
  } catch (error) {
    return {
      ok: false,
      issues: [],
      error: toErrorText(error instanceof Error ? error.message : String(error || 'unknown'))
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    error: ''
  }
}

const isAllowedDarwinDependency = (runtimeDir, dependencyPath) => {
  const normalizedDependency = String(dependencyPath || '').trim()
  if (!normalizedDependency) return true
  if (
    normalizedDependency.startsWith('@loader_path') ||
    normalizedDependency.startsWith('@executable_path') ||
    normalizedDependency.startsWith('@rpath')
  ) {
    return true
  }
  const resolvedDependency = normalizeResolvedPath(normalizedDependency)
  if (!resolvedDependency) return true
  if (isPathInside(runtimeDir, resolvedDependency)) return true
  return DARWIN_SYSTEM_LIBRARY_PREFIXES.some((prefix) => resolvedDependency.startsWith(prefix))
}

export const validatePortableDarwinRuntime = ({ runtimeDir, pythonPath, env }) => {
  if (process.platform !== 'darwin') {
    return {
      ok: true,
      payload: null,
      error: ''
    }
  }
  if (!fs.existsSync(pythonPath)) {
    return {
      ok: false,
      payload: null,
      error: `python missing: ${pythonPath}`
    }
  }

  const identity = inspectDarwinRuntimeIdentity({
    pythonPath,
    runtimeDir,
    env
  })
  if (!identity.ok || !identity.payload) {
    return {
      ok: false,
      payload: null,
      error: identity.error || `inspect failed: ${pythonPath}`
    }
  }

  const escapedRuntimePaths = Object.entries({
    executable: identity.payload.executable,
    prefix: identity.payload.prefix,
    base_prefix: identity.payload.base_prefix,
    base_exec_prefix: identity.payload.base_exec_prefix
  })
    .map(([key, value]) => [key, normalizeResolvedPath(value)])
    .filter(([, resolvedPath]) => !!resolvedPath)
    .filter(([, resolvedPath]) => !isPathInside(runtimeDir, resolvedPath))

  if (escapedRuntimePaths.length > 0) {
    return {
      ok: false,
      payload: identity.payload,
      error: `runtime paths escape root: ${escapedRuntimePaths.map(([key, value]) => `${key}=${value}`).join(' | ')}`
    }
  }

  const dependencyCheck = inspectDarwinBinaryDependencies({
    binaryPath: pythonPath
  })
  if (!dependencyCheck.ok) {
    return {
      ok: false,
      payload: identity.payload,
      error: dependencyCheck.error || `otool failed: ${pythonPath}`
    }
  }

  const externalDependencies = dependencyCheck.dependencies.filter(
    (dependencyPath) => !isAllowedDarwinDependency(runtimeDir, dependencyPath)
  )
  if (externalDependencies.length > 0) {
    const pythonFrameworkDependency = externalDependencies.find((dependencyPath) =>
      dependencyPath.includes('Python.framework')
    )
    return {
      ok: false,
      payload: {
        ...identity.payload,
        dependencies: dependencyCheck.dependencies
      },
      error: pythonFrameworkDependency
        ? `external Python.framework dependency: ${pythonFrameworkDependency}`
        : `external dylib dependencies: ${externalDependencies.join(' | ')}`
    }
  }

  const symlinkCheck = inspectDarwinRuntimeSymlinks({
    runtimeDir
  })
  if (!symlinkCheck.ok) {
    const symlinkIssue = symlinkCheck.issues.slice(0, 5).join(' | ')
    return {
      ok: false,
      payload: {
        ...identity.payload,
        dependencies: dependencyCheck.dependencies
      },
      error: symlinkCheck.error || `runtime symlink issues: ${symlinkIssue}`
    }
  }

  return {
    ok: true,
    payload: {
      ...identity.payload,
      dependencies: dependencyCheck.dependencies
    },
    error: ''
  }
}
