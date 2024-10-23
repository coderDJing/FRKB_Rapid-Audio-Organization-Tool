import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
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
          index: path.resolve(__dirname, 'src/renderer/', 'index.html'),
          databaseInit: path.resolve(__dirname, 'src/renderer/', 'databaseInit.html'),
          update: path.resolve(__dirname, 'src/renderer/', 'update.html'),
          foundNewVersion: path.resolve(__dirname, 'src/renderer/', 'foundNewVersion.html')
        }
      }
    }
  }
})
