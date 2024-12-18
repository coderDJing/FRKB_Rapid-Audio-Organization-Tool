import store from './store'
import { IDir, md5 } from '../types/globals'
import fs = require('fs-extra')
import path = require('path')
import fswin = require('fswin')
import os = require('os')
import net = require('net')

function parseJsonStrings(inputString: string) {
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
function splitStringByBytes(str: string, chunkSize = 1024) {
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

export async function exitSongsAnalyseServie() {
  const chunks = splitStringByBytes('exit')
  return new Promise((resolve, reject) => {
    const socketClient = new net.Socket()
    function writeNextChunk() {
      if (chunks.length > 0) {
        const chunk = chunks.shift()
        if (chunk) {
          if (socketClient.write(chunk)) {
            writeNextChunk() // 如果写入成功，继续写入下一个块
          } else {
            socketClient.once('drain', writeNextChunk) // 等待 drain 事件
          }
        }
      } else {
        socketClient.end()
      }
    }

    socketClient.connect(Number(store.analyseSongPort), '127.0.0.1', () => {
      writeNextChunk()
    })
    socketClient.on('data', (data: Buffer) => {})

    socketClient.on('error', (err: Error) => {
      console.log(err.toString())
      reject(err) // 拒绝 Promise 当发生错误时
      socketClient.destroy()
    })

    socketClient.on('close', () => {
      console.log('socketClient closed')
      resolve('exited') // 解决 Promise 当连接关闭时
    })
  })
}

interface SongsAnalyseResult {
  songsAnalyseResult: md5[]
  errorSongsAnalyseResult: md5[]
}

export async function getSongsAnalyseResult(
  songFilePaths: string[],
  processFunc: Function
): Promise<SongsAnalyseResult> {
  let songFileUrls = songFilePaths

  const chunks = splitStringByBytes(songFileUrls.join('|'))

  return new Promise((resolve, reject) => {
    const socketClient = new net.Socket()
    function writeNextChunk() {
      if (chunks.length > 0) {
        const chunk = chunks.shift()
        if (chunk) {
          if (socketClient.write(chunk)) {
            writeNextChunk() // 如果写入成功，继续写入下一个块
          } else {
            socketClient.once('drain', writeNextChunk) // 等待 drain 事件
          }
        }
      } else {
        socketClient.end()
      }
    }

    let songsAnalyseResult: md5[] = []
    let errorSongsAnalyseResult: md5[] = []

    socketClient.connect(Number(store.analyseSongPort), '127.0.0.1', () => {
      writeNextChunk()
    })
    socketClient.on('data', (data: Buffer) => {
      let md5s: string | md5[] = parseJsonStrings(data.toString())
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

    socketClient.on('error', (err: Error) => {
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
async function getdirsDescriptionJson(dirPath: string, dirs: fs.Dirent[]) {
  const jsons = await Promise.all(
    dirs.map(async (dir) => {
      try {
        const filePath = path.join(dirPath, dir.name, '.description.json')
        let descriptionJson = await fs.readJSON(filePath)
        descriptionJson.dirName = dir.name
        let types = ['root', 'library', 'dir', 'songList']
        if (descriptionJson.uuid && descriptionJson.type && types.includes(descriptionJson.type)) {
          const json: IDir = descriptionJson
          const subDirPath = path.join(dirPath, dir.name)
          const subEntries = await fs.readdir(subDirPath, { withFileTypes: true })
          const subDirs = subEntries.filter((entry) => entry.isDirectory())
          const subJsons = await getdirsDescriptionJson(subDirPath, subDirs)
          json.children = subJsons
          return json
        } else {
          return null
        }
      } catch (e) {
        return null
      }
    })
  )
  const filteredJsons = jsons.filter((json) => json !== null) as IDir[]
  return filteredJsons.sort((a, b) => {
    if (a.order === undefined || b.order === undefined) return 0
    return a.order - b.order
  })
}

//获取整个库的树结构
export async function getLibrary() {
  const dirPath = path.join(store.databaseDir, 'library')
  let descriptionJson = await fs.readJSON(path.join(dirPath, '.description.json'))
  descriptionJson.dirName = 'library'
  const rootDescriptionJson: IDir = descriptionJson
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory())
  const dirsDescriptionJson = await getdirsDescriptionJson(dirPath, dirs)
  rootDescriptionJson.children = dirsDescriptionJson
  return rootDescriptionJson
}

// 异步函数，用于读取和更新 .description.json 文件中的 order 属性
async function updateOrderInFile(filePath: string, type: 'minus' | 'plus') {
  try {
    const jsonObj = await fs.readJSON(filePath)
    if (type == 'minus') {
      jsonObj.order--
    } else if (type == 'plus') {
      jsonObj.order++
    }
    operateHiddenFile(filePath, async () => {
      await fs.outputJson(filePath, jsonObj)
    })
  } catch (error) {
    console.error(`Error updating ${filePath}:`, error)
  }
}
export const operateHiddenFile = async (filePath: string, operateFunction: Function) => {
  if (fs.pathExistsSync(filePath)) {
    if (os.platform() === 'win32') {
      await fswin.setAttributes(path.join(filePath), { IS_HIDDEN: false }, () => {})
    }
  }
  if (operateFunction && operateFunction.constructor.name === 'AsyncFunction') {
    await operateFunction()
  } else {
    operateFunction()
  }
  if (os.platform() === 'win32') {
    await fswin.setAttributes(path.join(filePath), { IS_HIDDEN: true }, () => {})
  }
}
// 异步函数，用于遍历目录并处理 .description.json 文件中的order小于参数orderNum时+1 direction='before'||'after' operation='plus'||'minus'
export const updateTargetDirSubdirOrder = async (
  dirPath: string,
  orderNum: number,
  direction: 'before' | 'after',
  operation: 'plus' | 'minus'
) => {
  try {
    const subdirs = await fs.readdir(dirPath, { withFileTypes: true })
    const dirs = subdirs.filter((dirent) => dirent.isDirectory())
    const promises = []
    for (const dirent of dirs) {
      const subdirPath = path.join(dirPath, dirent.name)
      const descriptionJsonPath = path.join(subdirPath, '.description.json')
      let description
      try {
        description = await fs.readJSON(descriptionJsonPath)
        let types = ['root', 'library', 'dir', 'songList']
        if (description.uuid && description.type && types.includes(description.type)) {
          if (direction == 'before') {
            if (description.order < orderNum) {
              promises.push(updateOrderInFile(descriptionJsonPath, operation))
            }
          } else if (direction == 'after') {
            if (description.order > orderNum) {
              promises.push(updateOrderInFile(descriptionJsonPath, operation))
            }
          }
        } else {
          continue
        }
      } catch (error) {
        continue
      }
    }
    await Promise.all(promises)
  } catch (error) {
    console.error(`Error traversing directory ${dirPath}:`, error)
  }
}
export const collectFilesWithExtensions = async (dir: string, extensions: string[] = []) => {
  let files: string[] = []
  try {
    const stats = await fs.stat(dir)

    if (stats.isFile()) {
      const ext = path.extname(dir).toLowerCase()
      if (extensions.includes(ext)) {
        return [dir]
      } else {
        return []
      }
    }

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
    return []
  }
}

export async function moveOrCopyItemWithCheckIsExist(
  src: string,
  targetPath: string,
  isMove: boolean
) {
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
  let now = new Date()

  let year = now.getFullYear()
  let month = now.getMonth() + 1 // 月份是从0开始的
  let day = now.getDate()
  let hour = now.getHours()
  let minute = now.getMinutes()
  let second = now.getSeconds()
  let millisecond = now.getMilliseconds()

  // 格式化月份、‌日期、‌小时、‌分钟、‌秒和毫秒
  let monthStr = month < 10 ? '0' + month : month
  let dayStr = day < 10 ? '0' + day : day
  let hourStr = hour < 10 ? '0' + hour : hour
  let minuteStr = minute < 10 ? '0' + minute : minute
  let secondStr = second < 10 ? '0' + second : second
  let millisecondStr =
    millisecond < 100 ? (millisecond < 10 ? '00' + millisecond : '0' + millisecond) : millisecond

  return (
    year +
    '' +
    monthStr +
    '' +
    dayStr +
    '' +
    hourStr +
    '' +
    minuteStr +
    '' +
    secondStr +
    '' +
    millisecondStr
  )
}
