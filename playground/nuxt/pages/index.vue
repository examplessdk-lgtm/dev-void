<script setup>
const hydrated = ref(false);
onNuxtReady(() => {
  hydrated.value = true;
});
</script>

<template>
  <h1 :data-hydrated="hydrated">Nuxt + Void</h1>
  <p>This playground demonstrates meta-framework integration.</p>
  <NuxtLink to="/smoke">Smoke Test</NuxtLink>
</template>
