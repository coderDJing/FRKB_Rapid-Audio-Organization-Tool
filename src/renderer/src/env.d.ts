/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, unknown>
  export default component
}

declare global {
  interface Window {
    __FRKB_AUDIO_CONTEXTS__?: AudioContext[]
  }
}

export {}
