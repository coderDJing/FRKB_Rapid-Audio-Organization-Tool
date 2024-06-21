<script setup>
import librarySelectArea from './modules/librarySelectArea.vue';
import libraryArea from './modules/libraryArea.vue';
// import { ref } from 'Vue'
// let libraryAreaWidth = ref(0)
// if (localStorage.getItem('libraryAreaWidth')) {
//     libraryAreaWidth = localStorage.getItem('libraryAreaWidth')
// }else{
//     libraryAreaWidth = 200
//     // localStorage.setItem('libraryAreaWidth')
// }
</script>
<template>
    <div style="display: flex;height: 100%">
        <librarySelectArea></librarySelectArea>
        <div style="width: 200px;border-right: 1px solid #2b2b2b;">
            <libraryArea></libraryArea>
        </div>
        <div style="width:4px;cursor:ew-resize;height: calc(100vh - 35px) ;position: absolute;left:243px"></div>
        <div style="flex-grow: 1;"></div>
    </div>
</template>