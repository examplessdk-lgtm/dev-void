<script setup lang="ts">
import type { Props } from './env.server';

defineProps<Props>();
</script>
<template>
  <div>
    <h1>Env</h1>
    <p>Environment bindings available via <code>c.env</code> in handlers.</p>

    <h2>Bindings ({{ bindings.length }})</h2>
    <table v-if="bindings.length">
      <thead>
        <tr>
          <th style="text-align: left">Name</th>
          <th style="text-align: left">Type</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="b in bindings" :key="b.name">
          <td>
            <code>{{ b.name }}</code>
          </td>
          <td>{{ b.type }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else><em>No bindings found.</em></p>
  </div>
</template>
