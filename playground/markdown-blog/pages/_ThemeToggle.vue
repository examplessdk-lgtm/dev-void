<script setup>
import { ref, onMounted } from 'vue';

const theme = ref('system');

const labels = { system: 'Auto', dark: 'Dark', light: 'Light' };

function applyTheme(value) {
  if (value === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = value;
  }
}

function toggle() {
  const next = { system: 'dark', dark: 'light', light: 'system' };
  theme.value = next[theme.value];
  localStorage.setItem('theme', theme.value);
  applyTheme(theme.value);
}

onMounted(() => {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark' || saved === 'light') {
    theme.value = saved;
    applyTheme(saved);
  }
});
</script>

<template>
  <button class="theme-toggle" @click="toggle">{{ labels[theme] }}</button>
</template>

<style scoped>
.theme-toggle {
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 0.25em 0.75em;
  font-size: 0.85em;
  cursor: pointer;
  background: transparent;
  color: inherit;
}

.theme-toggle:hover {
  background: #f1f5f9;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) .theme-toggle {
    border-color: #334155;
  }

  :root:not([data-theme='light']) .theme-toggle:hover {
    background: #1e293b;
  }
}

:root[data-theme='dark'] .theme-toggle {
  border-color: #334155;
}

:root[data-theme='dark'] .theme-toggle:hover {
  background: #1e293b;
}
</style>
