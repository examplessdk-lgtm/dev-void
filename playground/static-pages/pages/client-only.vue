<script setup lang="ts">
import type { Props } from './client-only.server.ts';

if (typeof window === 'undefined') {
  throw new Error('client-only static page component rendered on the server');
}

defineProps<Props>();
</script>

<template>
  <main>
    <h1 data-testid="client-only-title">{{ title }}</h1>
    <p data-testid="client-only-marker">{{ marker }}</p>
  </main>
</template>
