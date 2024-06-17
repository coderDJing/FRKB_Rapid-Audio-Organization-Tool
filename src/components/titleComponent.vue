<script setup>
import chromeClose from '@/assets/chrome-close.svg'
</script>
<template>
    <div class="titleComponent">
        <div>

        </div>
        <span>better music library for DJ</span>
        <div>
            <div>
                <img :src="chromeClose">
            </div>

        </div>
    </div>
</template>
<style lang="scss">
.titleComponent {
    width: 100vw;
    height: 30px;
    background-color: #2a2a2a;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
    padding: 0px 10px;
    box-sizing: border-box;
}
</style>