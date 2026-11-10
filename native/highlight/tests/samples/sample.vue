<template>
  <div :class="{ active: on }" @click="toggle">{{ message.toUpperCase() }}</div>
</template>
<script setup>
import { ref } from "vue";
const on = ref(false);
</script>
<style scoped>.active { font-weight: bold; }</style>
