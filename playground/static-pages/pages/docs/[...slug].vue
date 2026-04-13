<script setup lang="ts">
defineProps<{ slug: string }>();
</script>

<template>
  <div>
    <h1 data-testid="doc-title">Doc {{ slug }}</h1>
  </div>
</template>
