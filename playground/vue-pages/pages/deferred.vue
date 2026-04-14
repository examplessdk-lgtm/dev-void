<script setup lang="ts">
import type { Props } from './deferred.server';

defineProps<Props>();
</script>

<template>
  <div>
    <h1>{{ title }}</h1>
    <div v-if="stats.loading" data-testid="deferred-loading">Loading stats...</div>
    <div v-else-if="stats.error" data-testid="deferred-error">Error: {{ stats.error.message }}</div>
    <div v-else data-testid="deferred-resolved">Count: {{ stats.value.count }}</div>
  </div>
</template>
