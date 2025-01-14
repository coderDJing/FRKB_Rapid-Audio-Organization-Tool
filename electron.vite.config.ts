import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
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
          foundNewVersion: resolve(__dirname, 'src/renderer/', 'foundNewVersion.html'),
          foundOldVersionDatabase: resolve(
            __dirname,
            'src/renderer/',
            'foundOldVersionDatabase.html'
          )
        }
      }
    }
  }
})
