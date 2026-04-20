<script setup lang="ts">
import { useForm } from '@void/vue';
import { ref } from 'vue';
import type { Props } from './storage.server';

defineProps<Props>();

const fileInput = ref<HTMLInputElement>();

const uploadForm = useForm('/storage', {
  file: null as File | null,
});

async function handleUpload() {
  const file = fileInput.value?.files?.[0];
  if (!file) {
    return;
  }
  uploadForm.data.file = file;
  await uploadForm.post();
  if (fileInput.value) {
    fileInput.value.value = '';
  }
  uploadForm.data.file = null;
}

const deleteForm = useForm('/storage', {
  intent: 'delete',
  key: '',
});

function deleteObject(key: string) {
  deleteForm.data.key = key;
  deleteForm.post();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return bytes + ' B';
  }
  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + ' KB';
  }
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
</script>
<template>
  <div>
    <h1>Storage</h1>
    <p>Object storage via <code>void/storage</code>.</p>

    <h2>Upload File</h2>
    <form @submit.prevent="handleUpload">
      <input type="file" ref="fileInput" required />
      <button type="submit" :disabled="uploadForm.pending" style="margin-left: 5px">
        {{ uploadForm.pending ? 'Uploading...' : 'Upload' }}
      </button>
    </form>

    <h2>Objects ({{ objects.length }})</h2>
    <table v-if="objects.length">
      <thead>
        <tr>
          <th style="text-align: left">Key</th>
          <th style="text-align: left">Size</th>
          <th style="text-align: left">Uploaded</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="obj in objects" :key="obj.key">
          <td>
            <code>{{ obj.key }}</code>
          </td>
          <td>{{ formatSize(obj.size) }}</td>
          <td>{{ obj.uploaded }}</td>
          <td>
            <button @click="deleteObject(obj.key)" :disabled="deleteForm.pending">Delete</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else><em>No objects stored.</em></p>
  </div>
</template>
