<script setup lang="ts">
import type { FileTreeItem } from './FileTree.vue';

const items: FileTreeItem[] = [
  {
    name: 'routes/',
    children: [
      {
        name: 'api/',
        children: [
          { name: 'hello.ts', description: '→ GET|POST /api/hello' },
          {
            name: 'users/',
            children: [
              { name: 'index.ts', description: '→ GET|POST /api/users' },
              {
                name: '[id].ts',
                description: '→ GET|PUT|DELETE /api/users/:id',
              },
            ],
          },
          {
            name: 'search/',
            children: [
              {
                name: '[...query].ts',
                description: '→ GET /api/search/* (catch-all)',
              },
            ],
          },
        ],
      },
    ],
  },
];
</script>

<template>
  <FileTree :items="items" default-expanded />
</template>
