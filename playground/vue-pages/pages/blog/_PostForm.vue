<script setup lang="ts">
import { useIslandForm } from '@void/vue';

const form = useIslandForm({ title: '', body: '' });
</script>

<template>
  <form @submit.prevent="form.post('/blog')">
    <div>
      <label>Title:</label>
      <input v-model="form.data.title" />
      <span v-if="form.errors.title" style="color: red">{{ form.errors.title }}</span>
    </div>
    <div>
      <label>Body:</label>
      <textarea v-model="form.data.body" />
      <span v-if="form.errors.body" style="color: red">{{ form.errors.body }}</span>
    </div>
    <button type="submit" :disabled="form.pending">
      {{ form.pending ? 'Saving...' : 'Add Post' }}
    </button>
  </form>
</template>
