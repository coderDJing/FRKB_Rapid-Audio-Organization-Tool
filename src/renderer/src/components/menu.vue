<script setup>
import { watch } from 'vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { v4 as uuidv4 } from 'uuid'
import { useI18n } from 'vue-i18n'
const { tm } = useI18n()
const uuid = uuidv4()
const runtime = useRuntimeStore()

const emits = defineEmits(['menuButtonClick', 'update:modelValue'])
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
  }
})
watch(
  () => props.modelValue,
  () => {
    if (props.modelValue == true) {
      runtime.activeMenuUUID = uuid
    }
  }
)
const menuButtonClick = (item) => {
  runtime.activeMenuUUID = ''
  emits('menuButtonClick', item)
}
</script>
<template>
  <div class="menu" v-if="props.modelValue" @click.stop="() => { }">
    <div v-for="item of props.menuArr" class="menuGroup">
      <div v-for="button of item" class="menuButton" @click="menuButtonClick(button)"
        @contextmenu="menuButtonClick(button)">
        <span>{{ tm(button.name) }}</span>
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

      &:hover {
        background-color: #0078d4;
        color: white;
      }
    }
  }

  .menuGroup:last-child {
    border-bottom: 0px;
  }
}
</style>
