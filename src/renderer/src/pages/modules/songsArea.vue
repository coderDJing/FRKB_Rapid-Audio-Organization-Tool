<script setup>
import { watch, ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils.js'

const runtime = useRuntimeStore()
let songInfoArr = ref([])
let loading = ref(false)
watch(
  () => runtime.selectedSongListUUID,
  async () => {
    for (let item of songInfoArr.value) {
      if (item.coverUrl) {
        URL.revokeObjectURL(item.coverUrl)
      }
    }
    let songListPath = libraryUtils.findDirPathByUuid(
      runtime.libraryTree,
      runtime.selectedSongListUUID
    )
    loading.value = true
    let scanData = await window.electron.ipcRenderer.invoke('scanSongList', songListPath)
    loading.value = false
    for (let item of scanData) {
      if (item.cover) {
        let blob = new Blob([Uint8Array.from(item.cover.data)], { type: item.cover.format })
        const blobUrl = URL.createObjectURL(blob)
        item.coverUrl = blobUrl
      }
    }
    //todo v-for懒加载
    songInfoArr.value = scanData
  }
)

//todo 列拉伸 列显示隐藏 列顺序改变
</script>
<template>
  <div
    v-show="loadingShow"
    style="width: 100%; height: 100%; display: flex; justify-content: center; align-items: center"
  >
    <div class="loading"></div>
  </div>

  <div class="songItem lightBackground" v-if="songInfoArr.length > 0">
    <div
      class="coverDiv"
      style="border-right: 1px solid #000000; padding-left: 10px; box-sizing: border-box"
    >
      专辑封面
    </div>
    <div
      class="titleDiv"
      style="border-right: 1px solid #000000; padding-left: 10px; box-sizing: border-box"
    >
      曲目标题
    </div>
  </div>
  <!-- <div style="height: calc(100% - 30px) ;width: 100%;overflow-y: auto;">
          <div v-for="(item, index) of songInfoArr" :key="item.uuid" class="songItem"
            :class="{ lightBackground: index % 2 === 1, darkBackground: index % 2 === 0 }">
            <div class="coverDiv" style="overflow: hidden;">
              <img :src="item.coverUrl" class="unselectable" />
            </div>
            <div class="titleDiv">{{ item.title }}</div>
          </div>
        </div> -->
</template>
<style lang="scss" scoped>
.coverDiv {
  width: 15%;
  height: 30px;
  line-height: 30px;
  border-right: 1px solid #2b2b2b;

  img {
    width: 100%;
  }
}

.titleDiv {
  width: 20%;
  height: 30px;
  line-height: 30px;
  padding-left: 10px;
  box-sizing: border-box;
  border-right: 1px solid #2b2b2b;
  white-space: nowrap;
  overflow: hidden;
}

.songItem {
  width: 100%;
  height: 30px;
  display: flex;
  font-size: 14px;
}

.lightBackground {
  background-color: #191919;
}

.darkBackground {
  background-color: #000000;
}

.loading {
  display: block;
  position: relative;
  width: 6px;
  height: 10px;

  animation: rectangle infinite 1s ease-in-out -0.2s;

  background-color: #cccccc;
}

.loading:before,
.loading:after {
  position: absolute;
  width: 6px;
  height: 10px;
  content: '';
  background-color: #cccccc;
}

.loading:before {
  left: -14px;

  animation: rectangle infinite 1s ease-in-out -0.4s;
}

.loading:after {
  right: -14px;

  animation: rectangle infinite 1s ease-in-out;
}

@keyframes rectangle {
  0%,
  80%,
  100% {
    height: 20px;
    box-shadow: 0 0 #cccccc;
  }

  40% {
    height: 30px;
    box-shadow: 0 -20px #cccccc;
  }
}
</style>
