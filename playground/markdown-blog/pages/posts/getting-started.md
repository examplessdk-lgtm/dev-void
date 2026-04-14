---
title: Getting Started
description: Learn how to use Void
---

Welcome to **Void**. This is a markdown page rendered as a first-class route.

## Installation

```bash
npm create void@latest my-app
cd my-app
npm install
```

## Features

- File-based routing :rocket:
- Server-side rendering
- Island architecture
- **Zero client JS** by default

## Code Example

```ts
import { defineHandler } from 'void';

export const loader = defineHandler(() => {
  return { message: 'Hello from Void!' };
});
```

:::tip
Markdown pages automatically pre-render at build time with zero client JavaScript.
:::

:::warning
This is still in development — API may change.
:::

> [!NOTE]
> Markdown pages support all VitePress-equivalent features.

[[toc]]
