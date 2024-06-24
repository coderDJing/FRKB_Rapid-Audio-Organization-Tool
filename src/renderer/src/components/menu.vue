<script setup>
import { defineProps } from 'vue';
const props = defineProps({
  menuArr: {
    type: Array,
    required: true
  }
})
</script>
<template>
  <div class="menu">
    <div>
      123
    </div>
  </div>
</template>
<style lang="scss" scoped>
.menu {
  position: absolute;
  background-color: #1f1f1f;
  border: 1px solid #454545;
  font-size: 14px;
}
</style>
