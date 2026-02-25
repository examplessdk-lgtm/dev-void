export const SCAFFOLD_GITIGNORE_LINES = [
  "node_modules",
  "dist",
  ".void",
  "*.tsbuildinfo",
  ".DS_Store",
] as const;

export const SCAFFOLD_RUNTIME_DEPENDENCIES = {
  hono: "^4.11.9",
  vite: "^8.0.0-beta.14",
} as const;

export const SCAFFOLD_FILES = {
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
`,
  "vite.config.ts": `import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [voidPlugin()],
});
`,
  "src/main.ts": `const app = document.getElementById("app")!;

const res = await fetch("/api/hello");
const data = await res.json();

app.innerHTML = \`
  <h1>Welcome to Void</h1>
  <pre>\${JSON.stringify(data, null, 2)}</pre>
\`;
`,
  "routes/api/hello.get.ts": `import { defineHandler } from "void";

export default defineHandler(() => {
  return { message: "Hello from Void!", timestamp: Date.now() };
});
`,
} as const;
