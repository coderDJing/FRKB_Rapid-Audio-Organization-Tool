
import { defineStore } from 'pinia'

export const useRuntimeStore = defineStore('runtime', {
    state: () => {
        return {
            isWindowMaximized: null,
            libraryAreaSelected: 'listLibrary',
            layoutConfig: {
                libraryAreaWidth: 200
            }
        }
    }
})