// import audioDecode from 'audio-decode'
import * as fs from 'fs'
const Meyda = require('meyda')

class AudioFeatureExtractor {
  windowSize: number
  hopSize: number
  sampleRate: number
  numberOfMFCCCoefficients: number

  constructor(
    options: {
      windowSize?: number
      hopSize?: number
      sampleRate?: number
      numberOfMFCCCoefficients?: number
    } = {}
  ) {
    this.windowSize = options.windowSize || 2048
    this.hopSize = options.hopSize || 1024
    this.sampleRate = options.sampleRate || 44100
    this.numberOfMFCCCoefficients = options.numberOfMFCCCoefficients || 13
  }

  async extractMFCC(filePath: string) {
    try {
      // 读取音频文件
      const buffer = await fs.promises.readFile(filePath)
      const audioDecode = await import('audio-decode')
      // 使用 audioDecode 解码
      const audioBuffer = await audioDecode.default(buffer)
      // 计算音频数据的MD5
      const crypto = require('crypto')
      const md5Hash = crypto.createHash('md5')

      // 将AudioBuffer转换为Buffer以计算MD5
      const audioDataBuffer = Buffer.from(audioBuffer.getChannelData(0).buffer)
      md5Hash.update(audioDataBuffer)
      const md5Value = md5Hash.digest('hex')
      console.log('音频文件MD5:', md5Value)
      // 获取音频数据（如果是立体声，转换为单声道）
      const audioData = this.getMonoChannel(audioBuffer)

      // 配置 Meyda
      Meyda.numberOfMFCCCoefficients = this.numberOfMFCCCoefficients

      // 提取 MFCC 特征
      const mfccFeatures = []

      // 分帧处理
      for (let i = 0; i < audioData.length; i += this.hopSize) {
        const frame = audioData.slice(i, i + this.windowSize)
        if (frame.length === this.windowSize) {
          const features = Meyda.extract(['mfcc'], frame)
          if (features && features.mfcc) {
            mfccFeatures.push(features.mfcc)
          }
        }
      }

      return {
        mfcc: mfccFeatures,
        metadata: {
          sampleRate: audioBuffer.sampleRate,
          duration: audioBuffer.duration,
          numberOfChannels: audioBuffer.numberOfChannels
        }
      }
    } catch (error) {
      console.error('Error extracting MFCC:', error)
      throw error
    }
  }

  private getMonoChannel(audioBuffer: AudioBuffer): Float32Array {
    if (audioBuffer.numberOfChannels === 1) {
      return audioBuffer.getChannelData(0)
    }

    // 如果是多声道，转换为单声道
    const monoData = new Float32Array(audioBuffer.length)

    // 获取所有声道数据
    const channels = []
    for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
      channels.push(audioBuffer.getChannelData(i))
    }

    // 混合所有声道
    for (let i = 0; i < audioBuffer.length; i++) {
      let sum = 0
      for (const channel of channels) {
        sum += channel[i]
      }
      monoData[i] = sum / audioBuffer.numberOfChannels
    }

    return monoData
  }

  calculate_MFCC_Statistics(mfccFeatures: Float32Array[]) {
    const numCoefficients = this.numberOfMFCCCoefficients
    const numFrames = mfccFeatures.length

    // 初始化统计数组
    const mean = new Array(numCoefficients).fill(0)
    const std = new Array(numCoefficients).fill(0)
    const max = new Array(numCoefficients).fill(-Infinity)
    const min = new Array(numCoefficients).fill(Infinity)

    // 计算均值和最大/最小值
    for (let i = 0; i < numFrames; i++) {
      for (let j = 0; j < numCoefficients; j++) {
        const value = mfccFeatures[i][j]
        mean[j] += value
        max[j] = Math.max(max[j], value)
        min[j] = Math.min(min[j], value)
      }
    }

    // 完成均值计算
    for (let j = 0; j < numCoefficients; j++) {
      mean[j] /= numFrames
    }

    // 计算标准差
    for (let i = 0; i < numFrames; i++) {
      for (let j = 0; j < numCoefficients; j++) {
        const diff = mfccFeatures[i][j] - mean[j]
        std[j] += diff * diff
      }
    }

    for (let j = 0; j < numCoefficients; j++) {
      std[j] = Math.sqrt(std[j] / numFrames)
    }

    return { mean, std, max, min }
  }
}

export default AudioFeatureExtractor
