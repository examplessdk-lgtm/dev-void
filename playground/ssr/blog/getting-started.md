# Getting Started with Void

This guide walks you through setting up a Void project with SSR and blog support.

## Prerequisites

- Node.js 22+
- pnpm 11+

## Steps

1. Create a new project directory, then run `npm install -D void` and `npx void init`
2. Add `src/main.ssr.tsx` and `src/main.client.tsx` for SSR mode
3. Export a `prerender` function to generate static pages at build time
4. Deploy with `void deploy`
