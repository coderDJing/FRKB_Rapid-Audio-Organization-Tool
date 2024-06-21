<script setup>
import { useRuntimeStore } from '@/stores/runtime'
import { watch } from 'Vue';

const runtime = useRuntimeStore()
watch(() => runtime.libraryAreaSelected, () => {
    console.log(runtime.libraryAreaSelected)
}, {
    immediate: true
})
</script>
<template>
    <div style="height: 100%;width: 100%;display: flex;flex-grow: 1;background-color: #181818;">


    </div>
</template>
<style lang="scss" scoped></style>