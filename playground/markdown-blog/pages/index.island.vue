<script setup>
import pages from '@void/md/pages';

const posts = pages.filter((p) => p.path.startsWith('/posts'));
</script>

<template>
  <div>
    <h1>Blog</h1>
    <ul>
      <li v-for="post in posts" :key="post.path" style="margin-bottom: 0.75em">
        <a :href="post.path">{{ post.title }}</a>
        <p v-if="post.frontmatter.description" style="margin: 0.25em 0 0; color: #666">
          {{ post.frontmatter.description }}
        </p>
      </li>
    </ul>
  </div>
</template>
