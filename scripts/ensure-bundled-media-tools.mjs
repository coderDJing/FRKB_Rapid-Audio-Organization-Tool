import {
  ensureBundledMediaTools,
  logMediaToolsValidationResult,
  parseMediaToolsCliOptions
} from './lib/media-tools.mjs'

try {
  const options = parseMediaToolsCliOptions(process.argv.slice(2))
  const result = await ensureBundledMediaTools(options)
  if (result.changed) {
    console.log(
      `[media-tools] Auto-prepared bundled tools for ${result.platformKey} under ${result.vendorRoot}`
    )
  }
  if (!logMediaToolsValidationResult(result)) {
    process.exit(1)
  }
} catch (error) {
  const message =
    error instanceof Error
      ? [String(error.message || '').trim(), String(error.cause || '').trim()]
          .filter(Boolean)
          .join('\n')
      : String(error || 'unknown error')
  console.error(message)
  process.exit(1)
}
