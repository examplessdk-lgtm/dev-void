<script setup lang="ts">
import type { FileTreeItem } from './FileTree.vue';

function buildItems(ext: string): FileTreeItem[] {
  return [
    {
      name: 'pages/',
      children: [
        { name: `layout${ext}`, description: 'Root layout (wraps all pages)' },
        { name: `index${ext}`, description: '→ /' },
        {
          name: 'index.server.ts',
          description: 'Server-side loader & action for /',
        },
        { name: `about${ext}`, description: '→ /about' },
        {
          name: 'users/',
          children: [
            {
              name: `layout${ext}`,
              description: 'Nested layout for /users/*',
            },
            { name: `[id]${ext}`, description: '→ /users/:id' },
            {
              name: '[id].server.ts',
              description: 'Server-side loader & action for /users/:id',
            },
          ],
        },
        {
          name: 'blog/',
          children: [{ name: 'hello.md', description: '→ /blog/hello (Markdown page)' }],
        },
      ],
    },
  ];
}
</script>

<template>
  <FileTree :items="buildItems" adapter-tabs default-expanded />
</template>
