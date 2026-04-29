<script setup lang="ts">
import { Link } from '@void/vue';
import type { Props } from './index.server.ts';

defineProps<Props>();
</script>

<template>
  <div>
    <h1>Welcome</h1>
    <p>This is the Vue Pages playground.</p>
    <Link href="/users" prefetch="mount">Go to Users</Link>
    <Link href="/link-behavior">Link behavior</Link>
  </div>
</template>
