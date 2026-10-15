---
title: Void AI Assistant
description: Intelligent copilot for Void and Cloudflare Workers powered by Gemini with Google Search Grounding.
---

# Void AI Assistant

An intelligent multi-turn copilot built specifically for **Void** developers and **Cloudflare Workers** edge architectures, powered by **Google Gemini**.

::: tip Fast, General, or Complex Reasoning
Select the right model for your task:
- ⚡ **gemini-3.1-flash-lite**: High-speed, cost-optimized model for quick lookups and syntax questions.
- 🧠 **gemini-3.8-flash**: General-purpose model with **Google Search Grounding** enabled by default for up-to-date web documentation and release notes.
- 🔬 **gemini-4-argon**: Cutting-edge reasoning model for complex full-stack architectural design, deep debugging, and multi-file refactoring.
:::

## Interactive Assistant

Use the assistant below or toggle the floating AI widget in the bottom-right corner from any page in the documentation.

<ClientOnly>
  <GeminiChatbot />
</ClientOnly>

---

## Capabilities

### 1. Multi-Turn Conversation History
The assistant maintains context across multiple questions, allowing you to iterate on code, refine server routing, configure Cloudflare bindings (D1, KV, Queues), or troubleshoot deployment issues without repeating yourself.

### 2. Google Search Grounding
When enabled (active by default), queries that require current web information leverage Google Search Grounding with `gemini-3.8-flash`. All cited sources and documentation links are returned as clickable references directly in the message bubble.

### 3. Specialized Roles & System Instructions
Switch between tailored personas suited to your task:
- **Void Framework Expert**: Focused on Void's Vite plugin, server routes, client hydration, and hybrid pages.
- **Cloudflare Edge Specialist**: Guides on Workers limits, Durable Objects, KV storage, subrequests, and edge caching.
- **Full-Stack Code Architect**: Analyzes TypeScript types, frontend adapters (React, Vue, Svelte, Solid), and end-to-end full-stack safety.
