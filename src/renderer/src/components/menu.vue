<script setup>
import { watch } from 'vue';
const emit = defineEmits(['emitMenuEnd', 'menuButtonClick'])
const props = defineProps({
  menuArr: {
    type: Array,
    required: true
  },
  show: {
    type: Boolean,
    required: true
  }
})
const documentHandleClick = () => {
  document.removeEventListener('click', documentHandleClick)
  emit('emitMenuEnd')
}
watch(() => props.show, () => {
  if (props.show == true) {
    document.addEventListener('click', documentHandleClick)
  }
})
const menuButtonClick = (item) => {
  emit('menuButtonClick', item)
}

</script>
<template>
  <div class="menu" v-if="props.show" @click.stop="() => { }">
    <div v-for="item of props.menuArr" class="menuGroup">
      <div v-for="button of item" class="menuButton" @click="menuButtonClick(button)">
        <span>{{ button.name }}</span>
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
  width: 250px;
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
