# void

The Vite plugin for deploying full-stack apps to [Void](https://void.cloud). File-based API routing, typed database queries, and one-command deploys.

## Quick Start

```bash
npm install -D void
npx void init
```

Or add to an existing Vite project:

```bash
npm install -D void
npx void init
```

```ts
// vite.config.ts
import { voidPlugin } from "void";

export default {
  plugins: [voidPlugin()],
};
```

## Features

- **File-based API routing** on [Hono](https://hono.dev) with named HTTP method exports
- **Typed database** with auto-generated types from SQL migrations
- **Typed fetch client** with full route inference
- **Input validation** via any [Standard Schema](https://github.com/standard-schema/standard-schema) library (Zod, Valibot, ArkType)
- **Zero-config deploy** to Cloudflare's edge network

## Documentation

Full documentation is available at **[void.cloud/docs](https://void.cloud/docs)**.

## License

MIT
