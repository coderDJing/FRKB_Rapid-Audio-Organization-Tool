import store from './store.js'

const fs = require('fs-extra')
const path = require('path')
const iconv = require('iconv-lite')

function parseJsonStrings(inputString) {
  // 定义一个正则表达式来匹配 JSON 对象
  const jsonPattern = /(\{.*?\})/g

  // 匹配所有的 JSON 对象
  let matches = inputString.match(jsonPattern)

  // 如果没有匹配到任何 JSON 对象，直接返回原始字符串
  if (!matches) {
    return inputString
  }

  // 解析每个 JSON 对象
  const result = []
  for (let match of matches) {
    try {
      const parsedObj = JSON.parse(match)
      result.push(parsedObj)
    } catch (error) {
      // 如果解析失败，返回原始字符串
      return inputString
    }
  }

  // 如果所有 JSON 对象都解析成功，返回结果数组
  return result
}

// 分割字符串为多个字节块的函数
function splitStringByBytes(str, chunkSize = 1024) {
  const chunks = []
  let index = 0
  let currentChunkLength = 0
  let currentChunkBuffer = Buffer.alloc(0)
  while (index < str.length) {
    const charBuffer = Buffer.from(str.slice(index, index + 1), 'utf8')
    const charLength = charBuffer.length

    if (currentChunkLength + charLength > chunkSize) {
      chunks.push(currentChunkBuffer)
      currentChunkBuffer = charBuffer
      currentChunkLength = charLength
    } else {
      currentChunkBuffer = Buffer.concat([currentChunkBuffer, charBuffer])
      currentChunkLength += charLength
    }

    index++
  }
  if (currentChunkLength > 0) {
    chunks.push(currentChunkBuffer)
  }
  return chunks
}
export async function getSongsAnalyseResult(songFilePaths, processFunc) {
  let songFileUrls = songFilePaths

  const chunks = splitStringByBytes(songFileUrls.join('|'))

  return new Promise((resolve, reject) => {
    const net = require('net')
    const socketClient = new net.Socket()
    function writeNextChunk() {
      if (chunks.length > 0) {
        const chunk = chunks.shift()
        if (socketClient.write(chunk)) {
          writeNextChunk() // 如果写入成功，继续写入下一个块
        } else {
          socketClient.once('drain', writeNextChunk) // 等待 drain 事件
        }
      } else {
        socketClient.end()
      }
    }
    let songsAnalyseResult = []
    let errorSongsAnalyseResult = []

    socketClient.connect(store.analyseSongPort, '127.0.0.1', () => {
      writeNextChunk()
    })
    socketClient.on('data', (data) => {
      let md5s = parseJsonStrings(data.toString())
      if (!Array.isArray(md5s)) {
        console.log(data.toString())
      } else {
        for (let item of md5s) {
          if (item.md5_hash === 'error') {
            errorSongsAnalyseResult.push(item)
          } else {
            songsAnalyseResult.push(item)
          }
        }
      }
      processFunc(songsAnalyseResult.length + errorSongsAnalyseResult.length)
    })

    socketClient.on('error', (err) => {
      console.log(err.toString())
      reject(err) // 拒绝 Promise 当发生错误时
      socketClient.destroy()
    })

    socketClient.on('close', () => {
      console.log('socketClient closed')
      resolve({ songsAnalyseResult, errorSongsAnalyseResult }) // 解决 Promise 当连接关闭时
    })
  })
}
async function getdirsDescriptionJson(dirPath, dirs) {
  const jsons = await Promise.all(
    dirs.map(async (dir) => {
      const filePath = path.join(dirPath, dir.name, 'description.json')
      const json = await fs.readJSON(filePath)
      const subDirPath = path.join(dirPath, dir.name)
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
  const dirPath = path.join(store.databaseDir, 'library')
  const rootDescriptionJson = await fs.readJSON(path.join(dirPath, 'description.json'))
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
      const subdirPath = path.join(dirPath, dirent.name)
      const descriptionJsonPath = path.join(subdirPath, 'description.json')
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
      stdio: ['inherit', 'pipe', 'pipe'], // 继承stdin，pipe stdout和stderr到Node.js
      windowsHide: true
    })

    let stdoutData = ''
    let stderrData = ''

    child.stdout.on('data', (data) => {
      let iconvData = iconv.decode(data, 'gb18030')
      stdoutData = stdoutData + iconvData
      end()
    })

    child.stderr.on('data', (data) => {
      let iconvData = iconv.decode(data, 'gb18030')
      stderrData += iconvData
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

export async function moveOrCopyItemWithCheckIsExist(src, targetPath, isMove) {
  let isExist = await fs.pathExists(targetPath)
  if (isExist) {
    let counter = 1
    let baseName = path.basename(targetPath, path.extname(targetPath))
    let extension = path.extname(targetPath)
    let directory = path.dirname(targetPath)
    let newFileName = `${baseName} (${counter})${extension}`
    while (await fs.pathExists(path.join(directory, newFileName))) {
      counter++
      newFileName = `${baseName}(${counter})${extension}`
    }
    if (isMove) {
      fs.move(src, path.join(directory, newFileName))
    } else {
      fs.copy(src, path.join(directory, newFileName))
    }
    return path.join(directory, newFileName)
  } else {
    if (isMove) {
      fs.move(src, targetPath)
    } else {
      fs.copy(src, targetPath)
    }
    return targetPath
  }
}

export function getCurrentTimeYYYYMMDDHHMMSSSSS() {
  var now = new Date()

  var year = now.getFullYear()
  var month = now.getMonth() + 1 // 月份是从0开始的
  var day = now.getDate()
  var hour = now.getHours()
  var minute = now.getMinutes()
  var second = now.getSeconds()
  var millisecond = now.getMilliseconds()

  // 格式化月份、‌日期、‌小时、‌分钟、‌秒和毫秒
  month = month < 10 ? '0' + month : month
  day = day < 10 ? '0' + day : day
  hour = hour < 10 ? '0' + hour : hour
  minute = minute < 10 ? '0' + minute : minute
  second = second < 10 ? '0' + second : second
  millisecond =
    millisecond < 100 ? (millisecond < 10 ? '00' + millisecond : '0' + millisecond) : millisecond

  return year + '' + month + '' + day + '' + hour + '' + minute + '' + second + '' + millisecond
}
