<script setup>
import librarySelectArea from './modules/librarySelectArea.vue';
import libraryArea from './modules/libraryArea.vue';
</script>
<template>
    <div style="display: flex;height: 100%">
        <librarySelectArea></librarySelectArea>
        <div style="width: 200px;">
            <libraryArea></libraryArea>
        </div>
    </div>
</template>