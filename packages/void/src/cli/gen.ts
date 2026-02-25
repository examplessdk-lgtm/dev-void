import { intro, outro, log, select, isCancel, cancel } from "@clack/prompts";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

import type { GenArgs } from "./gen-args";

import { ensureProjectTsconfig } from "../codegen/project-tsconfig";
import { cliTitle } from "./output";

export async function runGenCommand(root: string, args: GenArgs): Promise<void> {
  console.log();
  intro(cliTitle("gen"));

  if (args.subcommand === "model") {
    await runModel(root, args.name, args.columns);
  } else if (args.subcommand === "migration") {
    runMigration(root, args.name);
  } else if (args.subcommand === "route") {
    runRoute(root, args.path, args.methods);
  } else if (args.subcommand === "middleware") {
    runMiddleware(root, args.name);
  } else if (args.subcommand === "cron") {
    runCron(root, args.name);
  } else if (args.subcommand === "queue") {
    runQueue(root, args.name);
  } else {
    runSsr(root, args.framework);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeIfNotExists(filePath: string, content: string): boolean {
  if (existsSync(filePath)) {
    log.warn(`Skipped (already exists): ${filePath}`);
    return false;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  log.success(`Created ${filePath}`);
  return true;
}

function getNextMigrationNumber(migrationsDir: string): string {
  if (!existsSync(migrationsDir)) {
    return "001";
  }
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql") && f !== "seed.sql");
  let max = 0;
  for (const file of files) {
    const match = file.match(/^(\d+)/);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return String(max + 1).padStart(3, "0");
}

function getNextMiddlewareNumber(middlewareDir: string): string {
  if (!existsSync(middlewareDir)) {
    return "01";
  }
  const files = readdirSync(middlewareDir);
  let max = 0;
  for (const file of files) {
    const match = file.match(/^(\d+)\./);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return String(max + 1).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Column type mapping
// ---------------------------------------------------------------------------

interface ColumnSpec {
  name: string;
  type: string;
  nullable: boolean;
}

function columnToSql(col: ColumnSpec): string {
  const sqlType = sqlTypeFor(col.type);
  const nullConstraint = col.nullable ? "" : " NOT NULL";
  return `  ${col.name} ${sqlType}${nullConstraint}`;
}

function sqlTypeFor(type: string): string {
  switch (type) {
    case "string":
    case "text":
    case "datetime":
      return "TEXT";
    case "integer":
    case "boolean":
      return "INTEGER";
    case "real":
      return "REAL";
    case "blob":
      return "BLOB";
    default:
      return "TEXT";
  }
}

// ---------------------------------------------------------------------------
// Validator detection + templates
// ---------------------------------------------------------------------------

type Validator = "valibot" | "zod" | "arktype" | "none";

export function detectValidator(root: string): Validator | null {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  if ("valibot" in allDeps) return "valibot";
  if ("zod" in allDeps) return "zod";
  if ("arktype" in allDeps) return "arktype";
  return null;
}

async function resolveValidator(root: string): Promise<Validator> {
  const detected = detectValidator(root);
  if (detected) {
    log.info(`Detected validator: ${detected}`);
    return detected;
  }

  const choice = await select({
    message: "No validation library detected. Which would you like to use?",
    options: [
      { value: "valibot", label: "Valibot" },
      { value: "zod", label: "Zod" },
      { value: "arktype", label: "ArkType" },
      { value: "none", label: "No validation" },
    ],
  });

  if (isCancel(choice)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  if (choice !== "none") {
    log.warn(`Remember to install ${choice}: npm install ${choice}`);
  }

  return choice as Validator;
}

function validatorTypeFor(validator: Validator, col: ColumnSpec): string {
  if (validator === "valibot") return valibotType(col);
  if (validator === "zod") return zodType(col);
  // arktype handled separately via string syntax
  return arktypeType(col);
}

function valibotType(col: ColumnSpec): string {
  let base: string;
  switch (col.type) {
    case "string":
    case "text":
    case "datetime":
      base = "v.string()";
      break;
    case "integer":
    case "real":
      base = "v.number()";
      break;
    case "boolean":
      base = "v.boolean()";
      break;
    case "blob":
      base = "v.instance(Blob)";
      break;
    default:
      base = "v.string()";
  }
  return col.nullable ? `v.optional(${base})` : base;
}

function zodType(col: ColumnSpec): string {
  let base: string;
  switch (col.type) {
    case "string":
    case "text":
    case "datetime":
      base = "z.string()";
      break;
    case "integer":
    case "real":
      base = "z.number()";
      break;
    case "boolean":
      base = "z.boolean()";
      break;
    case "blob":
      base = "z.instanceof(Blob)";
      break;
    default:
      base = "z.string()";
  }
  return col.nullable ? `${base}.optional()` : base;
}

function arktypeType(col: ColumnSpec): string {
  let base: string;
  switch (col.type) {
    case "string":
    case "text":
    case "datetime":
      base = "string";
      break;
    case "integer":
    case "real":
      base = "number";
      break;
    case "boolean":
      base = "boolean";
      break;
    case "blob":
      base = "instanceof Blob";
      break;
    default:
      base = "string";
  }
  return col.nullable ? `${base} | undefined` : base;
}

function getImportLine(validator: Validator): string | null {
  switch (validator) {
    case "valibot":
      return 'import * as v from "valibot";';
    case "zod":
      return 'import { z } from "zod";';
    case "arktype":
      return 'import { type } from "arktype";';
    case "none":
      return null;
  }
}

function getBodySchema(validator: Validator, columns: ColumnSpec[]): string {
  if (validator === "arktype") {
    const fields = columns.map((c) => `    ${c.name}: "${arktypeType(c)}",`).join("\n");
    return `type({\n${fields}\n  })`;
  }
  const fields = columns.map((c) => `    ${c.name}: ${validatorTypeFor(validator, c)},`).join("\n");
  const prefix = validator === "valibot" ? "v" : "z";
  return `${prefix}.object({\n${fields}\n  })`;
}

function getParamsSchema(validator: Validator): string {
  switch (validator) {
    case "valibot":
      return "v.object({ id: v.string() })";
    case "zod":
      return "z.object({ id: z.string() })";
    case "arktype":
      return 'type({ id: "string" })';
    case "none":
      return "";
  }
}

// ---------------------------------------------------------------------------
// Route templates
// ---------------------------------------------------------------------------

function generateIndexRoute(name: string, columns: ColumnSpec[], validator: Validator): string {
  const importLine = getImportLine(validator);
  const imports = [
    importLine,
    'import { defineHandler } from "void";',
    'import { db } from "void/db";',
  ]
    .filter(Boolean)
    .join("\n");

  const insertFields = columns.map((c) => `${c.name}: body.${c.name}`).join(", ");

  if (columns.length === 0 || validator === "none") {
    // No validator — plain handler
    if (columns.length > 0) {
      return `import { defineHandler } from "void";
import { db } from "void/db";

export const GET = defineHandler(async () => {
  return db.list("${name}");
});

export const POST = defineHandler(async (c) => {
  const body = await c.req.json();
  await db.insert("${name}", { ${insertFields} });
  return { created: true };
});
`;
    }
    return `import { defineHandler } from "void";
import { db } from "void/db";

export const GET = defineHandler(async () => {
  return db.list("${name}");
});

export const POST = defineHandler(async () => {
  await db.insert("${name}", {});
  return { created: true };
});
`;
  }

  const bodySchema = getBodySchema(validator, columns);
  return `${imports}

export const GET = defineHandler(async () => {
  return db.list("${name}");
});

export const POST = defineHandler.withValidator({
  body: ${bodySchema},
})(async (c, { body }) => {
  await db.insert("${name}", { ${insertFields} });
  return { created: true };
});
`;
}

function generateIdRoute(name: string, validator: Validator): string {
  if (validator === "none") {
    return `import { defineHandler } from "void";
import { db } from "void/db";

export const GET = defineHandler(async (c) => {
  const id = c.req.param("id");
  const row = await db.get("${name}", { where: { id: Number(id) } });

  if (!row) {
    return new Response("Not found", { status: 404 });
  }
  return row;
});
`;
  }

  const importLine = getImportLine(validator)!;
  const paramsSchema = getParamsSchema(validator);

  return `${importLine}
import { defineHandler } from "void";
import { db } from "void/db";

export const GET = defineHandler.withValidator({
  params: ${paramsSchema},
})(async (c, { params }) => {
  const row = await db.get("${name}", { where: { id: Number(params.id) } });

  if (!row) {
    return new Response("Not found", { status: 404 });
  }
  return row;
});
`;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function runModel(root: string, name: string, columns: ColumnSpec[]): Promise<void> {
  const validator = await resolveValidator(root);

  const migrationsDir = join(root, "migrations");
  mkdirSync(migrationsDir, { recursive: true });

  // 1. Migration
  const num = getNextMigrationNumber(migrationsDir);
  const migrationFile = join(migrationsDir, `${num}_create_${name}.sql`);
  const colDefs = columns.map(columnToSql);
  const allColDefs = [
    "  id INTEGER PRIMARY KEY AUTOINCREMENT",
    ...colDefs,
    "  created_at TEXT DEFAULT (datetime('now'))",
  ];
  const migrationSql = `CREATE TABLE IF NOT EXISTS ${name} (\n${allColDefs.join(",\n")}\n);\n`;
  writeIfNotExists(migrationFile, migrationSql);

  // 2. Route: routes/api/<name>/index.ts
  const routeIndexPath = join(root, "routes", "api", name, "index.ts");
  writeIfNotExists(routeIndexPath, generateIndexRoute(name, columns, validator));

  // 3. Route: routes/api/<name>/[id].ts
  const routeIdPath = join(root, "routes", "api", name, "[id].ts");
  writeIfNotExists(routeIdPath, generateIdRoute(name, validator));

  // 4. Regenerate db.d.ts
  const { collectMigrations } = await import("../migrations/collect");
  const { parseMigrationSchema } = await import("../migrations/schema");
  const { generateDbTypes } = await import("../codegen/db-types");

  const migrations = collectMigrations(migrationsDir);
  const schema = parseMigrationSchema(migrations);
  const dts = generateDbTypes(schema);
  const outDir = join(root, ".void");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "db.d.ts"), dts);
  ensureProjectTsconfig(root);
  log.success("Regenerated .void/db.d.ts");

  outro("Model scaffolding complete.");
}

function runMigration(root: string, name: string): void {
  const migrationsDir = join(root, "migrations");
  mkdirSync(migrationsDir, { recursive: true });

  const num = getNextMigrationNumber(migrationsDir);
  const filePath = join(migrationsDir, `${num}_${name}.sql`);
  writeIfNotExists(filePath, `-- ${name}\n`);

  outro("Migration created.");
}

function runRoute(root: string, routePath: string, methods: string[]): void {
  const filePath = join(root, "routes", routePath + ".ts");
  const exports = methods
    .map((m) => {
      const upper = m.toUpperCase();
      return `export const ${upper} = defineHandler(async () => {
  return { message: "${upper} ${routePath}" };
});`;
    })
    .join("\n\n");

  const content = `import { defineHandler } from "void";

${exports}
`;
  writeIfNotExists(filePath, content);

  outro("Route created.");
}

function runMiddleware(root: string, name: string): void {
  const middlewareDir = join(root, "middleware");
  mkdirSync(middlewareDir, { recursive: true });

  const num = getNextMiddlewareNumber(middlewareDir);
  const filePath = join(middlewareDir, `${num}.${name}.ts`);
  const content = `import { defineMiddleware } from "void";

export default defineMiddleware(async (c, next) => {
  // TODO: implement ${name} middleware
  await next();
});
`;
  writeIfNotExists(filePath, content);

  outro("Middleware created.");
}

function runCron(root: string, name: string): void {
  const filePath = join(root, "crons", name + ".ts");
  const content = `import { defineScheduled } from "void";

export const cron = "* * * * *";

export default defineScheduled(async (controller, env) => {
  // TODO: implement ${name}
});
`;
  writeIfNotExists(filePath, content);

  outro("Cron job created.");
}

function runQueue(root: string, name: string): void {
  const filePath = join(root, "queues", name + ".ts");
  const content = `import { defineQueue } from "void";

interface Message {}

// export const maxBatchSize = 10;
// export const maxBatchTimeout = 5;

export default defineQueue<Message>(async (batch, env) => {
  for (const message of batch.messages) {
    // TODO: process message
  }
});
`;
  writeIfNotExists(filePath, content);

  outro("Queue consumer created.");
}

function runSsr(root: string, framework?: "react" | "vue" | "svelte" | "solid"): void {
  if (!framework) {
    framework = detectFramework(root);
  }

  if (framework === "react") {
    writeReactSsr(root);
  } else if (framework === "vue") {
    writeVueSsr(root);
  } else if (framework === "svelte") {
    writeSvelteSsr(root);
  } else {
    writeSolidSsr(root);
  }

  outro("SSR scaffolding complete.");
}

function detectFramework(root: string): "react" | "vue" | "svelte" | "solid" {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    log.error(
      "No package.json found. Use --react, --vue, --svelte, or --solid to specify a framework.",
    );
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  if ("react" in allDeps) return "react";
  if ("vue" in allDeps) return "vue";
  if ("svelte" in allDeps) return "svelte";
  if ("solid-js" in allDeps) return "solid";

  log.error(
    "Could not detect framework from package.json. Use --react, --vue, --svelte, or --solid.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SSR templates
// ---------------------------------------------------------------------------

function writeReactSsr(root: string): void {
  writeIfNotExists(
    join(root, "src/main.ssr.tsx"),
    `import { renderToString } from "react-dom/server";
import { defineRender } from "void";
import App from "./App";

export default defineRender(async (c, assetTags) => {
  const appHtml = renderToString(<App />);
  const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    \${assetTags.head}
  </head>
  <body>
    <div id="root">\${appHtml}</div>
    \${assetTags.body}
  </body>
</html>\`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`,
  );

  writeIfNotExists(
    join(root, "src/main.client.tsx"),
    `import { hydrateRoot } from "react-dom/client";
import App from "./App";

hydrateRoot(document.getElementById("root")!, <App />);
`,
  );

  writeIfNotExists(
    join(root, "src/App.tsx"),
    `import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>Hello Void</h1>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Count: {count}
      </button>
    </main>
  );
}
`,
  );
}

function writeVueSsr(root: string): void {
  writeIfNotExists(
    join(root, "src/main.ssr.ts"),
    `import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { defineRender } from "void";
import App from "./App.vue";

export default defineRender(async (c, assetTags) => {
  const app = createSSRApp(App);
  const appHtml = await renderToString(app);
  const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    \${assetTags.head}
  </head>
  <body>
    <div id="app">\${appHtml}</div>
    \${assetTags.body}
  </body>
</html>\`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`,
  );

  writeIfNotExists(
    join(root, "src/main.client.ts"),
    `import { createSSRApp } from "vue";
import App from "./App.vue";

const app = createSSRApp(App);
app.mount("#app");
`,
  );

  writeIfNotExists(
    join(root, "src/App.vue"),
    `<script setup lang="ts">
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <main>
    <h1>Hello Void</h1>
    <button type="button" @click="count++">Count: {{ count }}</button>
  </main>
</template>
`,
  );
}

function writeSvelteSsr(root: string): void {
  writeIfNotExists(
    join(root, "src/main.ssr.ts"),
    `import { render } from "svelte/server";
import { defineRender } from "void";
import App from "./App.svelte";

export default defineRender(async (c, assetTags) => {
  const { html: appHtml } = render(App);
  const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    \${assetTags.head}
  </head>
  <body>
    <div id="app">\${appHtml}</div>
    \${assetTags.body}
  </body>
</html>\`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`,
  );

  writeIfNotExists(
    join(root, "src/main.client.ts"),
    `import { hydrate } from "svelte";
import App from "./App.svelte";

hydrate(App, { target: document.getElementById("app")! });
`,
  );

  writeIfNotExists(
    join(root, "src/App.svelte"),
    `<script>
  let count = $state(0);
</script>

<main>
  <h1>Hello Void</h1>
  <button type="button" onclick={() => count++}>Count: {count}</button>
</main>
`,
  );
}

function writeSolidSsr(root: string): void {
  writeIfNotExists(
    join(root, "src/main.ssr.tsx"),
    `import { renderToString } from "solid-js/web";
import { defineRender } from "void";
import App from "./App";

export default defineRender(async (c, assetTags) => {
  const appHtml = renderToString(() => <App />);
  const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    \${assetTags.head}
  </head>
  <body>
    <div id="app">\${appHtml}</div>
    \${assetTags.body}
  </body>
</html>\`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`,
  );

  writeIfNotExists(
    join(root, "src/main.client.tsx"),
    `import { hydrate } from "solid-js/web";
import App from "./App";

hydrate(() => <App />, document.getElementById("app")!);
`,
  );

  writeIfNotExists(
    join(root, "src/App.tsx"),
    `import { createSignal } from "solid-js";

export default function App() {
  const [count, setCount] = createSignal(0);

  return (
    <main>
      <h1>Hello Void</h1>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Count: {count()}
      </button>
    </main>
  );
}
`,
  );
}
