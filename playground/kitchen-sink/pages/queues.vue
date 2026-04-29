<script setup lang="ts">
import { useForm } from '@void/vue';
import type { Props } from './queues.server.ts';

defineProps<Props>();

const form = useForm('/queues', {
  key: '',
  value: '',
});

const deleteForm = useForm('/queues', {
  intent: 'delete',
  id: 0,
});

function deleteResult(id: number) {
  deleteForm.data.id = id;
  deleteForm.post();
}
</script>
<template>
  <div>
    <h1>Queues</h1>
    <p>
      Message queues via <code>void/queues</code>. Messages are sent to <code>demo-queue</code>,
      consumed and written to DB.
    </p>

    <h2>Send Message</h2>
    <form @submit.prevent="form.post()">
      <div>
        <label>Key: </label>
        <input v-model="form.data.key" placeholder="my-key" required />
      </div>
      <div style="margin-top: 5px">
        <label>Value: </label>
        <input v-model="form.data.value" placeholder="my-value" required />
      </div>
      <button type="submit" :disabled="form.pending" style="margin-top: 5px">
        {{ form.pending ? 'Sending...' : 'Send to Queue' }}
      </button>
    </form>

    <h2>Processed Results ({{ results.length }})</h2>
    <p>
      <em>Messages consumed from the queue are written to D1 via the consumer.</em>
    </p>
    <table v-if="results.length">
      <thead>
        <tr>
          <th style="text-align: left">Key</th>
          <th style="text-align: left">Value</th>
          <th style="text-align: left">Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in results" :key="r.id">
          <td>
            <code>{{ r.key }}</code>
          </td>
          <td>
            <code>{{ r.value }}</code>
          </td>
          <td>{{ r.createdAt }}</td>
          <td>
            <button @click="deleteResult(r.id)" :disabled="deleteForm.pending">Delete</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else><em>No results yet. Send a message and wait for the consumer to process it.</em></p>
  </div>
</template>
