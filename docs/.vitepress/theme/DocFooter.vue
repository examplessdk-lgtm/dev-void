<script setup>
import { FooterNav } from '@voidzero-dev/vitepress-theme';
import { useData } from 'vitepress';

const { frontmatter } = useData();
</script>

<template>
  <footer
    v-if="!frontmatter.layout || frontmatter.layout === 'doc'"
    class="doc-footer bg-[var(--vp-c-bg)]"
  >
    <FooterNav />
  </footer>
</template>

<style scoped>
.doc-footer :deep(.wrapper) {
  background-color: var(--vp-c-bg-alt);
}
:root.dark .doc-footer :deep(.wrapper) {
  background-color: transparent;
}
</style>
