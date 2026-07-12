const { execFile } = require('child_process')
const path = require('path')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

module.exports = async function (context) {
  if (context.electronPlatformName !== 'darwin') return

  const appFilename = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appFilename)

  await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', appPath])
}
