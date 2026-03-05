import { extendConfig } from "@voidzero-dev/vitepress-theme/config";
import type { IconOption } from "@voidzero-dev/vitepress-theme";
import { defineConfig } from "vitepress";
import { groupIconMdPlugin, groupIconVitePlugin } from "vitepress-plugin-group-icons";

const referenceItems = [
  { text: "Project Structure", link: "/reference/structure" },
  { text: "Resource Inference", link: "/reference/resource-inference" },
  {
    text: "Config",
    link: "/reference/config",
    collapsed: false,
    items: [
      { text: "target", link: "/reference/config#target" },
      { text: "routing", link: "/reference/config#routing" },
      { text: "inference", link: "/reference/config#inference" },
      { text: "output", link: "/reference/config#output" },
      { text: "remote", link: "/reference/config#remote" },
      { text: "worker", link: "/reference/config#worker" },
    ],
  },
  {
    text: "CLI",
    link: "/reference/cli",
    collapsed: false,
    items: [
      { text: "void init", link: "/reference/cli#setup" },
      { text: "void auth", link: "/reference/cli#auth" },
      { text: "void project", link: "/reference/cli#project-commands" },
      { text: "void deploy", link: "/reference/cli#deploy" },
      { text: "void db", link: "/reference/cli#database" },
      { text: "void gen", link: "/reference/cli#code-generation" },
      { text: "void secret", link: "/reference/cli#secrets" },
      { text: "void domain", link: "/reference/cli#custom-domains" },
      { text: "void init --agents", link: "/reference/cli#agent" },
    ],
  },
  {
    text: "API",
    link: "/reference/api",
    collapsed: false,
    items: [
      { text: "Plugin", link: "/reference/api#plugin" },
      { text: "Handlers", link: "/reference/api#handlers" },
      { text: "Auth", link: "/reference/api#auth" },
      { text: "Fetch Client", link: "/reference/api#fetch-client" },
      { text: "Database", link: "/reference/api#database" },
      { text: "Types", link: "/reference/api#types" },
      { text: "Environment Types", link: "/reference/api#environment-types" },
      { text: "Framework Adaptors", link: "/reference/api#framework-adaptors" },
      { text: "Subpath Exports", link: "/reference/api#subpath-exports" },
    ],
  },
];

const referenceLinks = {
  text: "Reference",
  activeMatch: "/reference/",
  items: referenceItems,
};

const integrationItems = [
  {
    text: "Meta Frameworks",
    collapsed: false,
    items: [
      { text: "Overview", link: "/integrations/frameworks/overview" },
      { text: "TanStack Start", link: "/integrations/frameworks/tanstack-start" },
      { text: "React Router", link: "/integrations/frameworks/react-router" },
      { text: "Astro", link: "/integrations/frameworks/astro" },
      { text: "SvelteKit", link: "/integrations/frameworks/sveltekit" },
      { text: "Nuxt", link: "/integrations/frameworks/nuxt" },
    ],
  },
  { text: "Coding Agents", link: "/integrations/agents" },
  { text: "Hono", link: "/integrations/hono" },
  { text: "Cloudflare", link: "/integrations/cloudflare" },
  { text: "Node.js / Bun / Deno", link: "/integrations/nodejs-bun-deno" },
  { text: "ORMs and External DBs", link: "/integrations/orms-and-external-dbs" },
  { text: "Auth Providers", link: "/integrations/auth-providers" },
  { text: "Payment Processors", link: "/integrations/payment-processors" },
];

const integrationLinks = {
  text: "Integrations",
  activeMatch: "/integrations/",
  items: integrationItems,
};

const resourcesLinks = {
  text: "Resources",
  items: [
    { text: "Recipes", link: "/recipes/", activeMatch: "/recipes/" },
    { text: "Examples", link: "/examples/", activeMatch: "/examples/" },
    { text: "Roadmap", link: "/roadmap/", activeMatch: "/roadmap/" },
    { text: "Blog", link: "https://voidzero.dev/blog" },
  ],
};

const socialLinks = [
  { icon: "x", link: "https://x.com/voidcloudhq" },
  { icon: "discord", link: "https://discord.gg/cC6TEVFKSx" },
  { icon: "github", link: "https://github.com/voidzero-dev/void" },
];

const platformLinks = {
  text: "Platform",
  items: [
    { text: "Company", link: "https://voidzero.dev" },
    { text: "Features", link: "/platform/features" },
    { text: "Pricing", link: "/platform/pricing" },
    { text: "Enterprise", link: "/platform/enterprise" },
  ],
};

export default extendConfig(
  defineConfig({
    title: "Void",
    description: "Build and deploy full-stack Vite apps at warp speed",
    cleanUrls: true,
    head: [["link", { rel: "icon", type: "image/svg+xml", href: "/icon.svg" }]],
    appearance: "dark",

    // ./index.server imports in code blocks are false positives
    ignoreDeadLinks: [/\/index$/],

    markdown: {
      config(md) {
        md.use(groupIconMdPlugin);
      },
    },

    vite: {
      plugins: [groupIconVitePlugin()],
    },

    themeConfig: {
      search: {
        provider: "local",
      },

      nav: [
        { text: "Guide", link: "/guide/", activeMatch: "/guide/" },
        integrationLinks,
        referenceLinks,
        resourcesLinks,
        platformLinks,
        { text: "Dashboard", link: "https://dash.void.cloud" },
      ],

      socialLinks,

      sidebar: {
        "/guide/": [
          {
            text: "Getting Started",
            icon: "lucide:rocket",
            collapsed: false,
            items: [
              { text: "Introduction", link: "/guide/" },
              { text: "Quickstart", link: "/guide/quickstart" },
            ],
          },
          {
            text: "Routing & Rendering",
            // @ts-expect-error
            icon: "lucide:route",
            collapsed: false,
            items: [
              { text: "Server Routing", link: "/guide/server-routing" },
              {
                text: "Pages Routing",
                collapsed: false,
                items: [
                  { text: "Overview", link: "/guide/pages-routing/overview" },
                  { text: "Loaders & Actions", link: "/guide/pages-routing/loaders-actions" },
                  { text: "Layouts & Shared Data", link: "/guide/pages-routing/layouts" },
                  { text: "Forms", link: "/guide/pages-routing/forms" },
                  { text: "Deferred Props", link: "/guide/pages-routing/deferred-props" },
                  { text: "View Transitions", link: "/guide/pages-routing/view-transitions" },
                  { text: "Head Management", link: "/guide/pages-routing/head" },
                  { text: "Islands", link: "/guide/pages-routing/islands" },
                  { text: "Markdown", link: "/guide/pages-routing/markdown" },
                ],
              },
              { text: "Custom SSR", link: "/guide/ssr" },
              { text: "SSG", link: "/guide/ssg" },
            ],
          },
          {
            text: "Data",
            icon: "lucide:database",
            collapsed: false,
            items: [
              { text: "Type Safety", link: "/guide/type-safety" },
              { text: "Database", link: "/guide/database" },
              { text: "Typed Fetch", link: "/guide/typed-fetch" },
              { text: "Key-Value Storage", link: "/guide/kv" },
              { text: "Object Storage", link: "/guide/storage" },
            ],
          },
          {
            text: "Platform",
            icon: "lucide:cloud",
            collapsed: false,
            items: [
              { text: "Supported App Types", link: "/guide/app-types" },
              { text: "Deployment", link: "/guide/deployment" },
              {
                text: "Edge Routing",
                collapsed: false,
                items: [
                  { text: "Static Assets Caching", link: "/guide/edge/static-assets" },
                  { text: "Revalidation (ISR)", link: "/guide/edge/revalidation" },
                  { text: "Edge Prerendering", link: "/guide/edge/prerendering" },
                  { text: "Custom Headers", link: "/guide/edge/headers" },
                  { text: "Redirects", link: "/guide/edge/redirects" },
                ],
              },
              { text: "AI", link: "/guide/ai" },
              { text: "Authentication", link: "/guide/auth" },
              { text: "Cron Jobs", link: "/guide/jobs" },
              { text: "Queues", link: "/guide/queues" },
              { text: "Environment Variables", link: "/guide/env-vars" },
            ],
          },
        ],
        "/integrations/": (() => {
          const frameworkIcons: Record<string, IconOption> = {
            "TanStack Start": "simple-icons:tanstack",
            "React Router": {
              light: "logos:react-router",
              dark: "vscode-icons:file-type-reactrouter",
            },
            Astro: { light: "logos:astro-icon", dark: "simple-icons:astro" },
            SvelteKit: "logos:svelte-icon",
            Nuxt: "logos:nuxt-icon",
          };
          const itemIcons: Record<string, IconOption> = {
            "Coding Agents": "lucide:bot",
            Hono: "logos:hono",
            Cloudflare: "devicon:cloudflare",
            "Node.js / Bun / Deno": "material-icon-theme:nodejs-alt",
            "ORMs and External DBs": "lucide:database",
            "Auth Providers": "lucide:shield",
            "Payment Processors": "lucide:credit-card",
          };
          return integrationItems.map((item) =>
            item.text === "Meta Frameworks"
              ? {
                  ...item,
                  icon: "lucide:blocks",
                  items: item.items?.map((child) => ({
                    ...child,
                    icon: frameworkIcons[child.text],
                  })),
                }
              : { ...item, icon: itemIcons[item.text] },
          );
        })(),
        "/reference/": (() => {
          const icons: Record<string, string> = {
            "Project Structure": "lucide:folder-tree",
            "Resource Inference": "lucide:scan-search",
            Config: "lucide:settings",
            API: "lucide:code",
            CLI: "lucide:terminal",
          };
          return referenceItems.map((item) => ({ ...item, icon: icons[item.text] }));
        })(),
      },

      footer: {
        // @ts-expect-error theme did not augment vitepress theme config
        nav: [
          {
            title: "Docs",
            items: [
              { text: "Guide", link: "/guide/" },
              { text: "Integrations", link: "/integrations/frameworks/overview" },
              { text: "Reference", link: "/reference/structure" },
            ],
          },
          {
            title: "Resources",
            items: resourcesLinks.items,
          },
          {
            title: "Platform",
            items: [
              ...platformLinks.items,
              {
                text: "Dashboard",
                link: "https://dash.void.cloud",
              },
            ],
          },
        ],
        social: socialLinks,
      },
    },
  }),
);
