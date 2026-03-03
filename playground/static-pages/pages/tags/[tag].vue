<script setup lang="ts">
defineProps<{ tag: string }>();
</script>

<template>
  <div>
    <h1 data-testid="tag-title">Tag {{ tag }}</h1>
  </div>
</template>
