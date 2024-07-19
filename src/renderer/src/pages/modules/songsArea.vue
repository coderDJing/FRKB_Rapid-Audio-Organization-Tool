<script setup>
import { watch, ref, nextTick } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import libraryUtils from '@renderer/utils/libraryUtils.js'

const runtime = useRuntimeStore()
let songInfoArr = ref([])
let loadingShow = ref(false)
watch(
  () => runtime.selectedSongListUUID,
  async () => {
    for (let item of songInfoArr.value) {
      if (item.coverUrl) {
        URL.revokeObjectURL(item.coverUrl)
      }
    }
    songInfoArr.value = []
    await nextTick(() => {})
    let songListPath = libraryUtils.findDirPathByUuid(
      runtime.libraryTree,
      runtime.selectedSongListUUID
    )
    let loadingSetTimeout = setTimeout(() => {
      loadingShow.value = true
    }, 100)
    let scanData = await window.electron.ipcRenderer.invoke('scanSongList', songListPath)
    clearTimeout(loadingSetTimeout)
    loadingShow.value = false
    for (let item of scanData) {
      if (item.cover) {
        let blob = new Blob([Uint8Array.from(item.cover.data)], { type: item.cover.format })
        const blobUrl = URL.createObjectURL(blob)
        item.coverUrl = blobUrl
      }
    }
    songInfoArr.value = scanData
    debugger
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
  <div
    style="height: 100%; width: 100%; overflow: auto"
    v-if="runtime.selectedSongListUUID && songInfoArr.length != 0"
  >
    <div class="songItem lightBackground" style="position: sticky; top: 0">
      <div
        class="coverDiv lightBackground"
        style="border-right: 1px solid #000000; padding-left: 10px; box-sizing: border-box"
      >
        专辑封面
      </div>
      <div
        class="titleDiv lightBackground"
        style="border-right: 1px solid #000000; padding-left: 10px; box-sizing: border-box"
      >
        曲目标题
      </div>
      <div
        class="titleDiv lightBackground"
        style="border-right: 1px solid #000000; padding-left: 10px; box-sizing: border-box"
      >
        作曲家
      </div>
      <div
        class="titleDiv lightBackground"
        style="border-right: 1px solid #000000; padding-left: 10px; box-sizing: border-box"
      >
        专辑
      </div>
    </div>
    <div>
      <div v-for="(item, index) of songInfoArr" :key="item.uuid" class="songItem">
        <div
          :class="{ lightBackground: index % 2 === 1, darkBackground: index % 2 === 0 }"
          style="display: flex"
        >
          <div class="coverDiv" style="overflow: hidden">
            <img :src="item.coverUrl" class="unselectable" />
          </div>
          <div class="titleDiv">{{ item.title }}</div>
          <div class="titleDiv">{{ item.artist }}</div>
          <div class="titleDiv">{{ item.album }}</div>
          <!-- todo 动态加载列 -->
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.coverDiv {
  width: 100px;
  height: 29px;
  line-height: 30px;
  border-right: 1px solid #2b2b2b;
  border-bottom: 1px solid transparent;

  img {
    width: 100%;
  }
}

.titleDiv {
  width: 200px;
  height: 30px;
  line-height: 30px;
  padding-left: 10px;
  box-sizing: border-box;
  border-right: 1px solid #2b2b2b;
  white-space: nowrap;
  overflow: hidden;
}

.songItem {
  width: 0;
  height: 30px;
  display: flex;
  font-size: 14px;

  div {
    flex-shrink: 0;
  }
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
