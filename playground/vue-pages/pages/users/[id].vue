<script setup lang="ts">
import { Link } from '@void/vue';
import type { Props } from './[id].server.ts';

const props = defineProps<Props>();
</script>

<template>
  <div>
    <h1>{{ user.name }}</h1>
    <p>Email: {{ user.email }}</p>
    <Link href="/users" prefetch>&larr; Back to Users</Link>
  </div>
</template>
