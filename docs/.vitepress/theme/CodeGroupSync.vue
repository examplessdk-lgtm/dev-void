<script setup lang="ts">
import { watch, onMounted } from 'vue';
import { selectedAdapter, syncCodeGroups, installCodeGroupListener } from './FileTree.vue';

watch(selectedAdapter, (val) => {
  syncCodeGroups(val);
});

onMounted(() => {
  installCodeGroupListener();
  syncCodeGroups(selectedAdapter.value);
});
</script>

<template>
  <span />
</template>
