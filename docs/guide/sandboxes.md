---
outline: deep
---

# Sandboxes

Void can wire Cloudflare Sandboxes into Void apps. A sandbox gives each session an isolated container for running commands, working with files, and exposing ports from server-side code.

```ts
import { defineHandler } from 'void';
import { getSandbox } from 'void/sandbox';

export const POST = defineHandler(async (c) => {
  const { command } = await c.req.json<{ command: string }>();
  const sandbox = getSandbox('default');
  const result = await sandbox.exec(command);

  return c.json(result);
});
```

Importing from `void/sandbox` enables the `SANDBOX` Durable Object binding, exports the SDK's `Sandbox` class from the generated Worker entry, and adds the matching `containers` and migration metadata to the Cloudflare worker config.

## Configuration

Most apps do not need config. The default binding is `SANDBOX`, the Durable Object class is `Sandbox`, local development uses the Dockerfile bundled with `@cloudflare/sandbox`, and `void deploy` uses the matching published sandbox image.

Use `void.json` when you need a custom image or container size:

```json
{
  "sandbox": {
    "image": "./Dockerfile.sandbox",
    "platformImage": "registry.example.com/acme/sandbox:latest",
    "instanceType": "lite",
    "maxInstances": 2
  }
}
```

Available fields:

| Field               | Default                        | Description                                              |
| ------------------- | ------------------------------ | -------------------------------------------------------- |
| `binding`           | `SANDBOX`                      | Worker binding name                                      |
| `className`         | `Sandbox`                      | Durable Object class exported by the Worker              |
| `containerName`     | `void-sandbox`                 | Cloudflare container app name                            |
| `image`             | Bundled sandbox SDK Dockerfile | Dockerfile path or registry image used by Wrangler/local |
| `imageBuildContext` | Directory of `image`           | Docker build context for Wrangler/local                  |
| `platformImage`     | Matching sandbox SDK image     | Registry image used by `void deploy`                     |
| `instanceType`      | `lite` on Void deploy          | Container size, such as `lite`, `basic`, `standard-1`    |
| `maxInstances`      | `20` on Void deploy            | Maximum number of container instances                    |

## Runtime API

`getSandbox(id, options)` returns the SDK sandbox stub for a session id. IDs are normalized by default so user-provided session ids can safely map to Durable Object names.

```ts
import { getSandbox } from 'void/sandbox';

const sandbox = getSandbox(`user-${user.id}`);
await sandbox.writeFile('/tmp/input.txt', 'hello');
const result = await sandbox.exec('cat /tmp/input.txt');
```

You can also use the namespace directly from `c.env.SANDBOX` when you need lower-level Durable Object control.

## Deployment

`void deploy` provisions the `SANDBOX` Durable Object namespace, attaches the Cloudflare Container metadata to the Worker upload, and creates or updates the matching container application in the Void platform account.

Platform deploys require a registry image reference. The default sandbox works without extra config. If `sandbox.image` points at a custom local Dockerfile, also set `sandbox.platformImage` to an image you have already pushed to a registry.
