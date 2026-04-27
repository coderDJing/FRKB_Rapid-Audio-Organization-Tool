import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const rendererDevPort = Number.parseInt(process.env.FRKB_DEV_SERVER_PORT || '', 10)
const rendererServer =
  Number.isInteger(rendererDevPort) && rendererDevPort > 0 && rendererDevPort <= 65535
    ? {
        port: rendererDevPort,
        strictPort: true
      }
    : undefined
const defaultLastFmApiKey = process.env.FRKB_LASTFM_API_KEY || process.env.LASTFM_API_KEY || ''

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          audioDecodeWorker: resolve(__dirname, 'src/main/workers/audioDecodeWorker.ts'),
          keyAnalysisWorker: resolve(__dirname, 'src/main/workers/keyAnalysisWorker.ts'),
          songListScanWorker: resolve(__dirname, 'src/main/workers/songListScanWorker.ts'),
          pioneerDeviceLibraryWorker: resolve(
            __dirname,
            'src/main/workers/pioneerDeviceLibraryWorker.ts'
          ),
          mixtapeWaveformWorker: resolve(__dirname, 'src/main/workers/mixtapeWaveformWorker.ts'),
          mixtapeRawWaveformWorker: resolve(
            __dirname,
            'src/main/workers/mixtapeRawWaveformWorker.ts'
          )
        },
        output: {
          entryFileNames: (chunk) => {
            if (chunk.name === 'audioDecodeWorker') {
              return 'workers/audioDecodeWorker.js'
            }
            if (chunk.name === 'keyAnalysisWorker') {
              return 'workers/keyAnalysisWorker.js'
            }
            if (chunk.name === 'songListScanWorker') {
              return 'workers/songListScanWorker.js'
            }
            if (chunk.name === 'pioneerDeviceLibraryWorker') {
              return 'workers/pioneerDeviceLibraryWorker.js'
            }
            if (chunk.name === 'mixtapeWaveformWorker') {
              return 'workers/mixtapeWaveformWorker.js'
            }
            if (chunk.name === 'mixtapeRawWaveformWorker') {
              return 'workers/mixtapeRawWaveformWorker.js'
            }
            return '[name].js'
          }
        }
      }
    },
    define: {
      'process.env.CLOUD_SYNC_BASE_URL_DEV': JSON.stringify(
        process.env.CLOUD_SYNC_BASE_URL_DEV || ''
      ),
      'process.env.CLOUD_SYNC_BASE_URL_PROD': JSON.stringify(
        process.env.CLOUD_SYNC_BASE_URL_PROD || ''
      ),
      'process.env.CLOUD_SYNC_API_SECRET_KEY': JSON.stringify(
        process.env.CLOUD_SYNC_API_SECRET_KEY || ''
      ),
      'process.env.FRKB_LASTFM_API_KEY': JSON.stringify(defaultLastFmApiKey)
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    plugins: [externalizeDepsPlugin()],
    define: {
      'process.env.CLOUD_SYNC_BASE_URL_DEV': JSON.stringify(
        process.env.CLOUD_SYNC_BASE_URL_DEV || ''
      ),
      'process.env.CLOUD_SYNC_BASE_URL_PROD': JSON.stringify(
        process.env.CLOUD_SYNC_BASE_URL_PROD || ''
      ),
      'process.env.CLOUD_SYNC_API_SECRET_KEY': JSON.stringify(
        process.env.CLOUD_SYNC_API_SECRET_KEY || ''
      )
    }
  },
  renderer: {
    server: rendererServer,
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler'
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/', 'index.html'),
          databaseInit: resolve(__dirname, 'src/renderer/', 'databaseInit.html'),
          update: resolve(__dirname, 'src/renderer/', 'update.html'),
          foundNewVersion: resolve(__dirname, 'src/renderer/', 'foundNewVersion.html'),
          whatsNew: resolve(__dirname, 'src/renderer/', 'whatsNew.html'),
          mixtape: resolve(__dirname, 'src/renderer/', 'mixtape.html')
        }
      }
    }
  }
})
