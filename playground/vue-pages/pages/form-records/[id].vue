<script setup lang="ts">
import { Link, useForm, useRouter } from '@void/vue';
import type { Props } from './[id].server.ts';

const props = defineProps<Props>();
const form = useForm('/form-records/:id', { name: props.name }, { params: { id: props.id } });
const router = useRouter();
</script>

<template>
  <h1>Editing {{ id }}</h1>
  <form @submit.prevent="form.post()">
    <input aria-label="Record name" v-model="form.data.name" />
    <button type="submit">Save record</button>
  </form>
  <Link href="/form-records/second">Next record</Link>
  <button @click="router.refresh()">Refresh record</button>
</template>
