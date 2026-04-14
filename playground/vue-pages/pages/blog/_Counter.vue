<script setup lang="ts">
import { ref } from 'vue';

const props = withDefaults(defineProps<{ initial?: number }>(), { initial: 0 });
const count = ref(props.initial);
</script>

<template>
  <div>
    <span data-testid="count">Count: {{ count }}</span>
    <button @click="count++">Increment</button>
  </div>
</template>
