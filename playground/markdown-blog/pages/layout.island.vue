<script setup>
import ThemeToggle from './_ThemeToggle.vue' with { island: 'load' };
import '@void/md/theme.css';
</script>

<template>
  <div class="page void-md">
    <header>
      <nav>
        <span class="nav-links">
          <a href="/">Home</a> | <a href="/posts/getting-started">Getting Started</a> |
          <a href="/posts/code-examples">Code Examples</a>
        </span>
        <ThemeToggle />
      </nav>
      <hr />
    </header>
    <slot />
  </div>
</template>

<style>
body {
  background: #f6f6f6;
}

.page {
  max-width: 960px;
  margin: 0 auto;
  padding: 1rem;
}

nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.nav-links a {
  margin: 0 10px;
}

.nav-links a:first-child {
  margin-left: 0;
}

/* Auto (system) dark mode */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) body {
    background: #161718;
    color: #e2e8f0;
  }
}

/* Explicit dark mode */
:root[data-theme='dark'] body {
  background: #161718;
  color: #e2e8f0;
}
</style>
