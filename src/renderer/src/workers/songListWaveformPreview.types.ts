import type { IPioneerPreviewWaveformData } from 'src/types/globals'
import type {
  MixxxWaveformData,
  WaveformStyle
} from '@renderer/pages/modules/songPlayer/webAudioPlayer'

export type SongListWaveformWorkerData =
  | {
      kind: 'mixxx'
      data: MixxxWaveformData
    }
  | {
      kind: 'pioneer'
      data: IPioneerPreviewWaveformData
    }
  | null

export type SongListWaveformWorkerIncoming =
  | {
      type: 'attachCanvas'
      payload: {
        canvasId: string
        canvas: OffscreenCanvas
      }
    }
  | {
      type: 'detachCanvas'
      payload: {
        canvasId: string
      }
    }
  | {
      type: 'setData'
      payload: {
        filePath: string
        data: SongListWaveformWorkerData
      }
    }
  | {
      type: 'clearData'
      payload: {
        filePath: string
      }
    }
  | {
      type: 'render'
      payload: {
        canvasId: string
        filePath: string
        width: number
        height: number
        pixelRatio: number
        waveformStyle: WaveformStyle
        isHalf: boolean
        baseColor: string
        progressColor: string
        playedPercent: number
      }
    }
  | {
      type: 'clearCanvas'
      payload: {
        canvasId: string
      }
    }
