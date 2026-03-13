<script setup lang="ts">
import type { Props } from "./large-props.server";

const props = defineProps<Props>();
</script>

<template>
  <div>
    <h1>{{ props.title }}</h1>
    <p>Data keys: {{ Object.keys(props.data).length }}</p>
    <div v-html="props.prerenderedHtml" />
  </div>
</template>
