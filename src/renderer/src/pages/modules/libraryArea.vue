<script setup>
import { ref, defineProps, computed } from 'vue'
const props = defineProps(
  {
    librarySelected: {
      type: String,
      required: true
    }
  }
)
let librarys = ref([])
window.electron.ipcRenderer.send('queryLibrary');
window.electron.ipcRenderer.on('libraryDescriptionFilesReaded', (event, descriptions) => {
  librarys.value = JSON.parse(descriptions)
})

let currentLibrary = computed(() => {
  return librarys.value.filter((item) => item.libraryName == props.librarySelected)
})
</script>
<template>
  <div style="height: 100%;width: 100%;display: flex;flex-grow: 1;background-color: #181818;">
    {{ currentLibrary }}

  </div>
</template>
<style lang="scss" scoped></style>
