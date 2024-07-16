<script setup>
const props = defineProps({
  title: {
    type: String
  },
  content: {
    type: Array
  },
  confirmShow: {
    type: Boolean,
    default: true
  },
  textAlign: {
    type: String,
    default: 'center'
  },
  innerHeight: {
    type: Number,
    default: 180
  },
  confirmCallback: {
    type: Function
  },
  cancelCallback: {
    type: Function
  }
})
const emits = defineEmits(['confirm', 'cancel'])
const confirm = () => {
  emits('confirm')
  if (props.confirmCallback) {
    props.confirmCallback()
  }
}
const cancel = () => {
  emits('cancel')
  if (props.cancelCallback) {
    props.cancelCallback()
  }
}
</script>
<template>
  <div class="dialog unselectable" style="position: absolute; font-size: 14px">
    <div style="
        width: 300px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      " class="inner" :style="'height:' + innerHeight + 'px'">

      <div>
        <div style="text-align: center; height: 30px; line-height: 30px; font-size: 14px">
          <span style="font-weight: bold">{{ props.title }}</span>
        </div>
        <div style="padding-left: 20px; padding-right: 20px">
          <div v-for="item of props.content" style="margin-top: 10px" :style="'text-align:' + textAlign">
            <span>{{ item }}</span>
          </div>
        </div>
      </div>
      <div v-if="confirmShow" style="display: flex; justify-content: center; padding-bottom: 10px">
        <div class="button" style="margin-right: 10px" @click="confirm()">确定</div>
        <div class="button" @click="cancel()">取消</div>
      </div>
      <div v-else="confirmShow" style="display: flex; justify-content: center; padding-bottom: 10px">
        <div class="button" @click="cancel()">关闭</div>
      </div>
    </div>
  </div>
</template>
<style lang="scss" scoped></style>
