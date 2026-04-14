<script setup lang="ts">
import { Link } from '@void/vue';
import type { Props } from './index.server';

defineProps<Props>();
</script>
<template>
  <div>
    <h1>{{ title }}</h1>
    <p>A playground app that exercises every major platform feature.</p>
    <ul>
      <li><Link href="/db">DB</Link> — D1 SQLite CRUD</li>
      <li><Link href="/kv">KV</Link> — Key-Value storage</li>
      <li><Link href="/storage">Storage</Link> — Object storage</li>
      <li><Link href="/ai">AI</Link> — Workers AI inference</li>
      <li><Link href="/cron">Cron</Link> — Scheduled jobs</li>
      <li><Link href="/queues">Queues</Link> — Message queues</li>
      <li><Link href="/env">Env</Link> — Environment bindings</li>
      <li><Link href="/revalidate">Revalidate</Link> — ISR revalidation</li>
      <li><Link href="/auth">Auth</Link> — Better Auth with explicit providers</li>
    </ul>
  </div>
</template>
