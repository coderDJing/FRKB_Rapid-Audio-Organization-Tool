<template>
  <titleComponent />
  <homePage />
</template>

<script setup>
import homePage from "./pages/homePage.vue"
import titleComponent from './components/titleComponent.vue'
</script>

<style lang="scss">
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: #cccccc;
  background-color: #1f1f1f;
  width: 100vw;
  height: 100vh;
}

body {
  margin: 0px;
  background-color: #1f1f1f;
}
</style>
