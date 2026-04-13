import {
  logMediaToolsValidationResult,
  parseMediaToolsCliOptions,
  validateBundledMediaTools
} from './lib/media-tools.mjs'

const options = parseMediaToolsCliOptions(process.argv.slice(2))
const result = validateBundledMediaTools(options)

if (!logMediaToolsValidationResult(result)) {
  process.exit(1)
}
