<script setup>
const props = defineProps({
  title: {
    type: String,
  },
  content: {
    type: Array,

  }
})
const emits = defineEmits(['confirm', 'cancel'])
const confirm = () => {
  emits('confirm')
}
const cancel = () => {
  emits('cancel')
}
</script>
<template>
  <div class="dialog unselectable" style="position: absolute;">
    <div style="width: 450px;height: 260px;display: flex;flex-direction: column;justify-content: space-between;"
      class="inner">
      <div>
        <div style="text-align: center;height:30px;line-height: 30px;font-size: 14px;"><span style="font-weight: bold;">{{
          props.title }}</span></div>
        <div style="padding-left: 20px;padding-top: 30px;padding-right: 20px;">
          <div v-for="item of props.content" style="text-align: center;margin-top: 10px;"><span>{{ item }}</span></div>
        </div>
      </div>
      <div style="display: flex;justify-content: center;padding-bottom: 10px;">
        <div class="button" style="margin-right: 10px;" @click="confirm()">
          确定
        </div>
        <div class="button" @click="cancel()">
          取消
        </div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped></style>
