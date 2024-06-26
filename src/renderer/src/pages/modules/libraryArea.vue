<script setup>
import { ref, computed, nextTick } from 'vue'
import rightClickMenu from '../../components/rightClickMenu.vue';
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
  querySonglist()
  return librarys.value.filter((item) => item.libraryName == props.librarySelected)
})

const querySonglist = () => {
  let library = librarys.value.filter((item) => item.libraryName == props.librarySelected)[0]
  if (library) {
    window.electron.ipcRenderer.send('querySonglist', library.path);
  }
}

const rightClickMenuShow = ref(false)
const clickEvent = ref({})
const menuArr = ref([])
const contextmenuEvent = (event) => {

  if (event.target.className.split(' ').indexOf('blankArea') != -1) {
    menuArr.value = [[{ name: '新建歌单' }, { name: '新建文件夹' }]]
  }
  clickEvent.value = event

  rightClickMenuShow.value = true



}
const menuButtonClick = (item) => {

}
</script>
<template>
  <div style="height: 100%;width: 100%;display: flex;flex-grow: 1;background-color: #181818;overflow: hidden;"
    @contextmenu.stop="contextmenuEvent">
    <div class="unselectable blankArea" v-if="currentLibrary.songListArr" style="height:100%;width: 100%;">

    </div>
    <div class="unselectable blankArea" v-else
      style="height:100%;width: 100%;display: flex;justify-content: center;align-items: center;">
      <span class="blankArea" style="font-size: 12px;color: #8c8c8c;">右键新建歌单</span>
    </div>
  </div>
  <rightClickMenu v-model="rightClickMenuShow" :menuArr="menuArr" :clickEvent="clickEvent"
    @menuButtonClick="menuButtonClick"></rightClickMenu>
</template>
<style lang="scss" scoped></style>
