<script setup lang="ts">
import { v4 as uuidV4 } from 'uuid'
import { ref, watch } from 'vue'

const uuid = uuidV4()
const props = defineProps({
  modelValue: {
    type: Boolean || undefined,
    required: true
  }
})

const value = ref(props.modelValue)
const emits = defineEmits(['update:modelValue', 'change'])
watch(
  () => value.value,
  (val) => {
    emits('update:modelValue', val)
  }
)

watch(
  () => props.modelValue,
  () => {
    value.value = props.modelValue
  }
)

function handleChange() {
  emits('change', value.value)
}
</script>
<template>
  <div class="checkBox">
    <input
      class="sure"
      type="checkbox"
      v-model="value"
      :value="true"
      @change="handleChange"
      :id="'checkBoxInput' + uuid"
    />
    <label :for="'checkBoxInput' + uuid"></label>
  </div>
</template>
<style lang="scss" scoped>
input[type='checkbox'] {
  visibility: hidden;
}

.checkBox {
  position: relative;
  width: 18px;
  height: 18px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 3px;
}

.checkBox label {
  position: absolute;
  width: 18px;
  height: 18px;
  top: 0;
  left: 0;
  background: var(--bg-elev);
  border-radius: 3px;
}

.checkBox label:after {
  opacity: 0;
  /*修改为0*/
  content: '';
  position: absolute;
  width: 11px;
  height: 7px;
  background: transparent;
  top: 2px;
  left: 3px;
  border: 1px solid var(--accent);
  border-top: none;
  border-right: none;

  -webkit-transform: rotate(-45deg);
  -moz-transform: rotate(-45deg);
  -o-transform: rotate(-45deg);
  -ms-transform: rotate(-45deg);
  transform: rotate(-45deg);
}

.checkBox label:hover::after {
  opacity: 0;
}

.checkBox input[type='checkbox']:checked + label:after {
  opacity: 1;
}
</style>
