<script setup lang="ts">
defineProps<{ slug: string }>();
</script>

<template>
  <div>
    <h1 data-testid="post-title">Post {{ slug }}</h1>
  </div>
</template>
