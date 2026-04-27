<script setup lang="ts">
import { computed, type PropType } from 'vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'

const props = defineProps({
  value: {
    type: [String, Number] as PropType<string | number>,
    required: true
  },
  badgeText: {
    type: String,
    required: true
  },
  badgeTitle: {
    type: String,
    required: true
  },
  onlyWhenOverflow: {
    type: Boolean,
    default: true
  }
})

const valueTitle = computed(() => String(props.value))
</script>

<template>
  <bubbleBoxTrigger
    tag="span"
    class="cell-title__text"
    :title="valueTitle"
    :only-when-overflow="onlyWhenOverflow"
  >
    {{ value }}
  </bubbleBoxTrigger>
  <bubbleBoxTrigger tag="span" class="curated-artist-count-badge" :title="badgeTitle">
    {{ badgeText }}
  </bubbleBoxTrigger>
</template>

<style scoped lang="scss">
.cell-title__text {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: clip;
}

.curated-artist-count-badge {
  flex: 0 0 auto;
  margin-left: auto;
  min-width: 24px;
  max-width: 56px;
  height: 16px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(200, 162, 60, 0.14);
  border: 1px solid rgba(200, 162, 60, 0.34);
  color: #a67a08;
  font-size: 11px;
  font-weight: 700;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
