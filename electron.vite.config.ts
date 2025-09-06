import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  main: {
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
  preload: {
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
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler'
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/', 'index.html'),
          databaseInit: resolve(__dirname, 'src/renderer/', 'databaseInit.html'),
          update: resolve(__dirname, 'src/renderer/', 'update.html'),
          foundNewVersion: resolve(__dirname, 'src/renderer/', 'foundNewVersion.html')
        }
      }
    }
  }
})
