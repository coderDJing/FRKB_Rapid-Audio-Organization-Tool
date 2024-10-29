<script setup>
import { watch, ref } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { v4 as uuidV4 } from 'uuid'
import { t } from '@renderer/utils/translate'
import hotkeys from 'hotkeys-js'
import utils from '../utils/utils'
const uuid = uuidV4()
const runtime = useRuntimeStore()

const emits = defineEmits(['menuButtonClick', 'update:modelValue', 'switchMenu'])
watch(
  () => runtime.activeMenuUUID,
  (val) => {
    if (val !== uuid) {
      emits('update:modelValue', false)
    }
  }
)
const props = defineProps({
  menuArr: {
    type: Array,
    required: true
  },
  modelValue: {
    type: Boolean,
    required: true
  },
  menuName: {
    type: String
  }
})
watch(
  () => props.modelValue,
  () => {
    if (props.modelValue == true) {
      selectedMenuButton.value = ''
      utils.setHotkeysScpoe(uuid)
      runtime.activeMenuUUID = uuid
      hotkeys('w', uuid, () => {
        let menuArr = props.menuArr.flat(1)
        if (selectedMenuButton.value === '') {
          selectedMenuButton.value = menuArr[menuArr.length - 1].name
          return
        }
        let index = menuArr.findIndex((item) => item.name === selectedMenuButton.value)
        if (index === 0) {
          selectedMenuButton.value = menuArr[menuArr.length - 1].name
        } else {
          selectedMenuButton.value = menuArr[index - 1].name
        }
      })
      hotkeys('s', uuid, () => {
        let menuArr = props.menuArr.flat(1)
        if (selectedMenuButton.value === '') {
          selectedMenuButton.value = menuArr[0].name
          return
        }
        let index = menuArr.findIndex((item) => item.name === selectedMenuButton.value)
        if (index === menuArr.length - 1) {
          selectedMenuButton.value = menuArr[0].name
        } else {
          selectedMenuButton.value = menuArr[index + 1].name
        }
      })
      hotkeys('e', uuid, () => {
        if (selectedMenuButton.value === '') {
          return
        }
        let menuArr = props.menuArr.flat(1)
        for (let button of menuArr) {
          if (button.name === selectedMenuButton.value) {
            menuButtonClick(button)
            break
          }
        }
      })
      hotkeys('q', uuid, () => {
        emits('update:modelValue', false)
      })
      hotkeys('d', uuid, () => {
        emits('switchMenu', 'next', props.menuName)
      })
      hotkeys('a', uuid, () => {
        emits('switchMenu', 'prev', props.menuName)
      })
    } else {
      selectedMenuButton.value = ''
      utils.delHotkeysScope(uuid)
    }
  }
)

const menuButtonClick = (item) => {
  runtime.activeMenuUUID = ''
  emits('menuButtonClick', item)
}
const selectedMenuButton = ref('')
</script>
<template>
  <div class="menu" v-if="props.modelValue" @click.stop="() => {}">
    <div
      v-for="item of props.menuArr"
      class="menuGroup"
      @mouseleave="
        () => {
          selectedMenuButton = ''
        }
      "
    >
      <div
        v-for="button of item"
        class="menuButton"
        @click="menuButtonClick(button)"
        :class="{ menuButtonHover: selectedMenuButton === button.name }"
        @mouseenter="
          () => {
            selectedMenuButton = button.name
          }
        "
        @contextmenu="menuButtonClick(button)"
      >
        <span>{{ t(button.name) }}</span>
        <span>{{ button.shortcutKey }}</span>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.menu {
  position: absolute;
  background-color: #1f1f1f;
  border: 1px solid #454545;
  font-size: 14px;
  width: 310px;
  border-radius: 5px;

  .menuGroup {
    border-bottom: 1px solid #454545;
    padding: 5px 5px;

    .menuButton {
      display: flex;
      justify-content: space-between;
      padding: 5px 20px;
      border-radius: 5px;
    }

    .menuButtonHover {
      background-color: #0078d4;
      color: white;
    }
  }

  .menuGroup:last-child {
    border-bottom: 0px;
  }
}
</style>
