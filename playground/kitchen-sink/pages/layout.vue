<script setup lang="ts">
import { Link, useShared } from '@void/vue';
const shared = useShared();
</script>
<template>
  <div style="font-family: monospace; max-width: 800px; margin: 0 auto; padding: 20px">
    <nav style="padding-bottom: 10px; margin-bottom: 20px; border-bottom: 1px solid #ccc">
      <strong>{{ shared.appName }}</strong> &mdash; <Link href="/">Home</Link> |
      <Link href="/db">DB</Link> | <Link href="/kv">KV</Link> |
      <Link href="/storage">Storage</Link> | <Link href="/ai">AI</Link> |
      <Link href="/sandbox">Sandbox</Link> | <Link href="/cron">Cron</Link> |
      <Link href="/queues">Queues</Link> | <Link href="/env">Env</Link> |
      <Link href="/revalidate">Revalidate</Link> |
      <Link href="/auth">Auth</Link>
    </nav>
    <slot />
  </div>
</template>
