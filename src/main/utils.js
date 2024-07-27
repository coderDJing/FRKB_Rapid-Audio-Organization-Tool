import { join } from 'path'
const fs = require('fs-extra')
const path = require('path')

async function getdirsDescriptionJson(dirPath, dirs) {
  const jsons = await Promise.all(
    dirs.map(async (dir) => {
      const filePath = join(dirPath, dir.name, 'description.json')
      const json = await fs.readJSON(filePath)
      const subDirPath = join(dirPath, dir.name)
      const subEntries = await fs.readdir(subDirPath, { withFileTypes: true })
      const subDirs = subEntries.filter((entry) => entry.isDirectory())
      const subJsons = await getdirsDescriptionJson(subDirPath, subDirs)
      json.children = subJsons
      return json
    })
  )

  return jsons.sort((a, b) => a.order - b.order)
}

//获取整个库的树结构
export async function getLibrary() {
  const dirPath = join(__dirname, 'library')
  const rootDescriptionJson = await fs.readJSON(join(dirPath, 'description.json'))
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory())
  const dirsDescriptionJson = await getdirsDescriptionJson(dirPath, dirs)
  rootDescriptionJson.children = dirsDescriptionJson
  return rootDescriptionJson
}

// 异步函数，用于读取和更新 description.json 文件中的 order 属性
async function updateOrderInFile(filePath, type) {
  try {
    const jsonObj = await fs.readJSON(filePath)
    if (type == 'minus') {
      jsonObj.order--
    } else if (type == 'plus') {
      jsonObj.order++
    }
    await fs.outputJson(filePath, jsonObj)
  } catch (error) {
    console.error(`Error updating ${filePath}:`, error)
  }
}

// 异步函数，用于遍历目录并处理 description.json 文件中的order小于参数orderNum时+1 direction='before'||'after' operation='plus'||'minus'
export const updateTargetDirSubdirOrder = async (dirPath, orderNum, direction, operation) => {
  try {
    const subdirs = await fs.readdir(dirPath, { withFileTypes: true })
    const dirs = subdirs.filter((dirent) => dirent.isDirectory())
    const promises = []
    for (const dirent of dirs) {
      const subdirPath = join(dirPath, dirent.name)
      const descriptionJsonPath = join(subdirPath, 'description.json')
      let description = await fs.readJSON(descriptionJsonPath)
      if (direction == 'before') {
        if (description.order < orderNum) {
          promises.push(updateOrderInFile(descriptionJsonPath, operation))
        }
      } else if (direction == 'after') {
        if (description.order > orderNum) {
          promises.push(updateOrderInFile(descriptionJsonPath, operation))
        }
      }
    }
    await Promise.all(promises)
  } catch (error) {
    console.error(`Error traversing directory ${dirPath}:`, error)
  }
}

export const collectFilesWithExtensions = async (dir, extensions = []) => {
  try {
    let files = []

    // 读取目录中的文件和子目录
    const directoryEntries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of directoryEntries) {
      const fullPath = path.join(dir, entry.name)

      // 如果是文件，检查扩展名
      if (entry.isFile()) {
        const ext = path.extname(fullPath).toLowerCase()
        if (extensions.includes(ext)) {
          files.push(fullPath)
        }
      } else if (entry.isDirectory()) {
        // 如果是目录，递归调用
        const subFiles = await collectFilesWithExtensions(fullPath, extensions)
        files = files.concat(subFiles)
      }
    }

    return files
  } catch (error) {
    console.log(error)
  }
}

const { spawn } = require('child_process')
export function executeScript(exePath, args, end) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, {
      stdio: ['inherit', 'pipe', 'pipe'] // 继承stdin，pipe stdout和stderr到Node.js
    })

    let stdoutData = ''
    let stderrData = ''

    child.stdout.on('data', (data) => {
      stdoutData = stdoutData + data.toString()
      end()
    })

    child.stderr.on('data', (data) => {
      stderrData += data.toString()
    })

    child.on('error', (err) => {
      reject(err)
    })

    child.on('close', (code) => {
      if (code === 0) {
        let dataArr = stdoutData.split('||')
        if (dataArr.length > 1) {
          dataArr.pop()
        }
        let result = []
        let errorResult = []
        for (let item of dataArr) {
          if (item.split('|')[0].replace(/\r\n/g, '') === 'error') {
            errorResult.push({
              path: item.split('|')[1]
            })
          } else {
            result.push({
              md5_hash: item.split('|')[0].replace(/\r\n/g, ''),
              path: item.split('|')[1]
            })
          }
        }
        resolve({ result, errorResult })
      } else {
        // 非零退出码通常表示错误
        reject(new Error(`子进程退出，退出代码：${code}\n${stderrData}`))
      }
    })
  })
}
