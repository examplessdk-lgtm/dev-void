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
      link: https://github.com/voidzero-dev/void
  image:
    src: /hero.svg
    alt: Void deployment platform

features:
  - iconify: lucide:layers
    title: Truly Full-Stack
    details: Database, KV storage, object storage, AI inference, authentication, queues, and cron jobs are built in. Import what you need and ignore the rest.
  - iconify: lucide:wand-sparkles
    title: Your Code is Your Infra
    details: Void scans your source code, detects what you use, and provisions resources automatically. No config files or dashboard clicks, either locally or in the cloud.
  - iconify: lucide:shield-check
    title: End-to-End Type Safety
    details: Types flow from Drizzle schema through route handlers to page component props and the frontend fetch client. One schema validates at runtime and infers types at build time.
  - iconify: lucide:blocks
    title: Any Framework, Any Rendering
    details: React, Vue, Svelte, Solid, plus Vite-based meta-frameworks. Use SSR, SSG, ISR, islands, and markdown where they fit.
  - iconify: lucide:bot
    title: AI-Native
    details: Built-in skills, MCP support, and reference prompts let coding agents scaffold and ship full-stack apps in a single prompt.
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
