---
layout: home
theme: dark

hero:
  name: Void.
  text: Ship full-stack Vite apps at warp speed
  tagline: Void is a deployment platform designed for Vite - with a powerful backend SDK that makes your Vite apps truly full-stack.
  actions:
    - theme: brand
      text: Get Started
      link: ./guide/
    - theme: alt
      text: View on GitHub
      link: https://github.com/voidzerodev/void
  image:
    src: /hero.svg
    alt: Void deployment platform

features:
  - iconify: lucide:layers
    title: Truly Full-Stack
    details: Database, KV storage, object storage, AI inference, authentication, queues, and cron jobs — all built in. Import what you need, skip what you don't.
  - iconify: lucide:wand-sparkles
    title: Your Code is Your Infra
    details: Void scans your source code, detects what you use, and provisions every resource automatically — no config files, no dashboard clicks. Locally and in the cloud.
  - iconify: lucide:shield-check
    title: End-to-End Type Safety
    details: Types flow from SQL migrations through route handlers to page component props and the frontend fetch client. One schema validates at runtime and infers types at build time.
  - iconify: lucide:blocks
    title: Any Framework, Same DX
    details: Pages mode works with React, Vue, Svelte, and Solid, under a unified, Inertia-inspired routing system. Vite-based meta frameworks are also supported and enjoy the same backend DX!
  - iconify: lucide:shuffle
    title: Every Rendering Model
    details: SSR, SSG, ISR, islands with partial hydration, and markdown — mix and match per page. Choose the right strategy for each route, not one mode for the whole app.
  - iconify: lucide:terminal
    title: One Command to Production
    details: "`void deploy` builds your app, runs migrations, provisions resources, and deploys to Cloudflare Workers, without requiring a Cloudflare account or knowledge about the infra."

footer_heading: Build and Deploy at Warp Speed
footer_subheading: npm install void
---

<script setup>
import Home from './.vitepress/theme/Home.vue'
</script>

<Home />
