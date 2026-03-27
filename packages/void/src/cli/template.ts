export const SCAFFOLD_GITIGNORE_LINES = [
  "node_modules",
  "dist",
  ".void",
  ".wrangler",
  "*.tsbuildinfo",
  ".DS_Store",
] as const;

export type ScaffoldFramework = "react" | "vue" | "svelte" | "solid";
export type ScaffoldStarterMode = "sqlite" | "postgresql" | "static";

export const SCAFFOLD_BASE_DEPENDENCIES = {
  hono: "^4.11.9",
} as const;

export const SCAFFOLD_BASE_DEV_DEPENDENCIES = {
  vite: "^8.0.0-beta.14",
  typescript: "^5.9.3",
} as const;

export const SCAFFOLD_FRAMEWORK_OPTIONS = [
  { value: "react", label: "React", hint: "TSX Pages starter with the React adapter." },
  { value: "vue", label: "Vue", hint: "Vue SFC Pages starter with the Vue adapter." },
  { value: "svelte", label: "Svelte", hint: "Svelte 5 Pages starter with the Svelte adapter." },
  {
    value: "solid",
    label: "Solid",
    hint: "Fine-grained TSX Pages starter with the Solid adapter.",
  },
] as const;

interface ScaffoldFrameworkConfig {
  label: string;
  adapterPackage: string;
  adapterVersion: string;
  adapterImport: string;
  adapterPlugin: string;
  pageExtension: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  tsconfigCompilerOptions: Record<string, string>;
}

export const SCAFFOLD_FRAMEWORKS: Record<ScaffoldFramework, ScaffoldFrameworkConfig> = {
  react: {
    label: "React",
    adapterPackage: "@void/react",
    adapterVersion: "^0.0.1",
    adapterImport: "voidReact",
    adapterPlugin: "@void/react/plugin",
    pageExtension: "tsx",
    dependencies: {
      react: "^19.2.4",
      "react-dom": "^19.2.4",
    },
    devDependencies: {
      "@types/react": "^19.2.14",
      "@types/react-dom": "^19.2.3",
    },
    tsconfigCompilerOptions: {
      jsx: "react-jsx",
    },
  },
  vue: {
    label: "Vue",
    adapterPackage: "@void/vue",
    adapterVersion: "^0.0.1",
    adapterImport: "voidVue",
    adapterPlugin: "@void/vue/plugin",
    pageExtension: "vue",
    dependencies: {
      vue: "^3.5.30",
    },
    devDependencies: {},
    tsconfigCompilerOptions: {
      jsx: "preserve",
    },
  },
  svelte: {
    label: "Svelte",
    adapterPackage: "@void/svelte",
    adapterVersion: "^0.0.1",
    adapterImport: "voidSvelte",
    adapterPlugin: "@void/svelte/plugin",
    pageExtension: "svelte",
    dependencies: {
      svelte: "^5.53.9",
    },
    devDependencies: {},
    tsconfigCompilerOptions: {},
  },
  solid: {
    label: "Solid",
    adapterPackage: "@void/solid",
    adapterVersion: "^0.0.1",
    adapterImport: "voidSolid",
    adapterPlugin: "@void/solid/plugin",
    pageExtension: "tsx",
    dependencies: {
      "solid-js": "^1.9.11",
    },
    devDependencies: {},
    tsconfigCompilerOptions: {
      jsx: "preserve",
      jsxImportSource: "solid-js",
    },
  },
};

export interface PagesStarterTemplate {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  files: Record<string, string>;
}

export function detectScaffoldFrameworkFromDependencies(
  deps: Record<string, unknown>,
): ScaffoldFramework | undefined {
  for (const [framework, config] of Object.entries(SCAFFOLD_FRAMEWORKS) as [
    ScaffoldFramework,
    ScaffoldFrameworkConfig,
  ][]) {
    if (config.adapterPackage in deps) {
      return framework;
    }
  }
  return undefined;
}

export function getScaffoldTsconfigCompilerOptions(
  framework?: ScaffoldFramework,
): Record<string, string> {
  return framework ? { ...SCAFFOLD_FRAMEWORKS[framework].tsconfigCompilerOptions } : {};
}

export function createPagesStarterTemplate(options: {
  framework: ScaffoldFramework;
  starterMode: ScaffoldStarterMode;
  voidVersion: string;
}): PagesStarterTemplate {
  const { framework, starterMode, voidVersion } = options;
  const config = SCAFFOLD_FRAMEWORKS[framework];
  const files: Record<string, string> = {
    "vite.config.ts": getViteConfig(config),
    [`pages/index.${config.pageExtension}`]: getIndexPage(framework, starterMode),
  };

  if (starterMode !== "static") {
    files["pages/index.server.ts"] = getIndexServer();
    files["routes/api/hello.ts"] = getHelloRoute(config.label, starterMode);
    files["db/schema.ts"] = getSchemaFile(starterMode);
    files["db/migrations/0000_initial.sql"] = getMigrationFile(starterMode);
  }

  return {
    scripts: {
      dev: "vite",
      build: "vite build",
      preview: "vite preview",
    },
    dependencies: {
      ...SCAFFOLD_BASE_DEPENDENCIES,
      ...config.dependencies,
    },
    devDependencies: {
      void: `^${voidVersion}`,
      ...SCAFFOLD_BASE_DEV_DEPENDENCIES,
      [config.adapterPackage]: config.adapterVersion,
      ...config.devDependencies,
    },
    files,
  };
}

function getViteConfig(config: ScaffoldFrameworkConfig): string {
  return `import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { ${config.adapterImport} } from "${config.adapterPlugin}";

export default defineConfig({
  plugins: [voidPlugin(), ${config.adapterImport}()],
});
`;
}

function getIndexServer(): string {
  return `import { defineHandler, type InferProps } from "void";
import { db, desc } from "void/db";
import { messages } from "@schema";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async () => {
  const rows = await db.select().from(messages).orderBy(desc(messages.id));
  return { messages: rows };
});
`;
}

function getHelloRoute(
  frameworkLabel: string,
  starterMode: Exclude<ScaffoldStarterMode, "static">,
): string {
  const databaseLabel = starterMode === "postgresql" ? "PostgreSQL" : "D1";
  return `import { defineHandler } from "void";

export const GET = defineHandler(() => {
  return {
    message: "Hello from Void",
    framework: "${frameworkLabel}",
    database: "${databaseLabel}",
  };
});
`;
}

function getSchemaFile(starterMode: Exclude<ScaffoldStarterMode, "static">): string {
  if (starterMode === "postgresql") {
    return `import { pgTable, serial, text, timestamp } from "void/schema-pg";

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
`;
  }

  return `import { sql } from "void/db";
import { integer, sqliteTable, text } from "void/schema-d1";

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull().default(sql\`(datetime('now'))\`),
});
`;
}

function getMigrationFile(starterMode: Exclude<ScaffoldStarterMode, "static">): string {
  if (starterMode === "postgresql") {
    return `CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

INSERT INTO messages (text) VALUES ('Hello from Void');
`;
  }

  return `CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO messages (text) VALUES ('Hello from Void');
`;
}

function getIndexPage(framework: ScaffoldFramework, starterMode: ScaffoldStarterMode): string {
  if (starterMode === "static") {
    switch (framework) {
      case "react":
        return `export default function HomePage() {
  return (
    <main>
      <h1>Welcome to Void</h1>
      <p>This starter is running in Pages mode with no database or server code yet.</p>
      <p>
        Add <code>pages/*.server.ts</code>, <code>routes/</code>, or <code>void/db</code> when
        you want to grow into full-stack features.
      </p>
    </main>
  );
}
`;
      case "vue":
        return `<template>
  <main>
    <h1>Welcome to Void</h1>
    <p>This starter is running in Pages mode with no database or server code yet.</p>
    <p>
      Add <code>pages/*.server.ts</code>, <code>routes/</code>, or <code>void/db</code> when you
      want to grow into full-stack features.
    </p>
  </main>
</template>
`;
      case "svelte":
        return `<main>
  <h1>Welcome to Void</h1>
  <p>This starter is running in Pages mode with no database or server code yet.</p>
  <p>
    Add <code>pages/*.server.ts</code>, <code>routes/</code>, or <code>void/db</code> when you
    want to grow into full-stack features.
  </p>
</main>
`;
      case "solid":
        return `export default function HomePage() {
  return (
    <main>
      <h1>Welcome to Void</h1>
      <p>This starter is running in Pages mode with no database or server code yet.</p>
      <p>
        Add <code>pages/*.server.ts</code>, <code>routes/</code>, or <code>void/db</code> when
        you want to grow into full-stack features.
      </p>
    </main>
  );
}
`;
    }
  }

  switch (framework) {
    case "react":
      return `import type { Props } from "./index.server";

export default function HomePage({ messages }: Props) {
  return (
    <main>
      <h1>Welcome to Void</h1>
      <p>
        This starter is running in Pages mode. The list below is loaded from your database in
        <code> pages/index.server.ts</code>.
      </p>
      <p>
        API example: <a href="/api/hello">/api/hello</a>
      </p>
      <ul>
        {messages.map((message) => (
          <li key={message.id}>
            <strong>{message.text}</strong>
            <br />
            <small>{String(message.createdAt)}</small>
          </li>
        ))}
      </ul>
    </main>
  );
}
`;
    case "vue":
      return `<script setup lang="ts">
import type { Props } from "./index.server";

defineProps<Props>();
</script>

<template>
  <main>
    <h1>Welcome to Void</h1>
    <p>
      This starter is running in Pages mode. The list below is loaded from your database in
      <code>pages/index.server.ts</code>.
    </p>
    <p>
      API example: <a href="/api/hello">/api/hello</a>
    </p>
    <ul>
      <li v-for="message in messages" :key="message.id">
        <strong>{{ message.text }}</strong>
        <br />
        <small>{{ String(message.createdAt) }}</small>
      </li>
    </ul>
  </main>
</template>
`;
    case "svelte":
      return `<script lang="ts">
  import type { Props } from "./index.server";

  let { messages }: Props = $props();
</script>

<main>
  <h1>Welcome to Void</h1>
  <p>
    This starter is running in Pages mode. The list below is loaded from your database in
    <code>pages/index.server.ts</code>.
  </p>
  <p>
    API example: <a href="/api/hello">/api/hello</a>
  </p>
  <ul>
    {#each messages as message (message.id)}
      <li>
        <strong>{message.text}</strong>
        <br />
        <small>{String(message.createdAt)}</small>
      </li>
    {/each}
  </ul>
</main>
`;
    case "solid":
      return `import type { Props } from "./index.server";

export default function HomePage(props: Props) {
  return (
    <main>
      <h1>Welcome to Void</h1>
      <p>
        This starter is running in Pages mode. The list below is loaded from your database in
        <code> pages/index.server.ts</code>.
      </p>
      <p>
        API example: <a href="/api/hello">/api/hello</a>
      </p>
      <ul>
        {props.messages.map((message) => (
          <li>
            <strong>{message.text}</strong>
            <br />
            <small>{String(message.createdAt)}</small>
          </li>
        ))}
      </ul>
    </main>
  );
}
`;
  }
}
