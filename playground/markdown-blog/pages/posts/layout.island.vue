<script setup>
import { useFrontmatter } from '@void/md';
import pages from '@void/md/pages';

const fm = useFrontmatter();
const posts = pages.filter((p) => p.path.startsWith('/posts'));
</script>

<template>
  <div style="display: flex; gap: 2rem">
    <aside style="width: 200px; flex-shrink: 0">
      <h3>Posts</h3>
      <nav>
        <ul style="list-style: none; padding: 0">
          <li v-for="post in posts" :key="post.path" style="margin-bottom: 0.5em">
            <a :href="post.path">{{ post.title }}</a>
          </li>
        </ul>
      </nav>
    </aside>
    <main class="void-md" style="flex: 1; min-width: 0">
      <h1 v-if="fm.title">{{ fm.title }}</h1>
      <slot />
    </main>
  </div>
</template>
