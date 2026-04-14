import type { IconOption } from '@voidzero-dev/vitepress-theme';
import { extendConfig } from '@voidzero-dev/vitepress-theme/config';
import { defineConfig } from 'vitepress';
import { groupIconMdPlugin, groupIconVitePlugin } from 'vitepress-plugin-group-icons';

const referenceItems = [
  {
    text: 'General',
    collapsed: false,
    items: [
      { text: 'Project Structure', link: '/reference/structure' },
      { text: 'Resource Inference', link: '/reference/resource-inference' },
    ],
  },
  {
    text: 'Config',
    link: '/reference/config',
    collapsed: true,
    items: [
      { text: 'target', link: '/reference/config#target' },
      { text: 'routing', link: '/reference/config#routing' },
      { text: 'inference', link: '/reference/config#inference' },
      { text: 'output', link: '/reference/config#output' },
      { text: 'remote', link: '/reference/config#remote' },
      { text: 'worker', link: '/reference/config#worker' },
    ],
  },
  {
    text: 'CLI',
    link: '/reference/cli',
    collapsed: true,
    items: [
      { text: 'void init', link: '/reference/cli#setup' },
      { text: 'void auth', link: '/reference/cli#auth' },
      { text: 'void project', link: '/reference/cli#project-commands' },
      { text: 'void deploy', link: '/reference/cli#deploy' },
      { text: 'void db', link: '/reference/cli#database' },
      { text: 'void gen', link: '/reference/cli#code-generation' },
      { text: 'void secret', link: '/reference/cli#secrets' },
      { text: 'void domain', link: '/reference/cli#custom-domains' },
      { text: 'void init --agents', link: '/reference/cli#agent' },
    ],
  },
  {
    text: 'API',
    link: '/reference/api',
    collapsed: true,
    items: [
      { text: 'Plugin', link: '/reference/api#plugin' },
      { text: 'Handlers', link: '/reference/api#handlers' },
      { text: 'Auth', link: '/reference/api#auth' },
      { text: 'Fetch Client', link: '/reference/api#fetch-client' },
      { text: 'Database', link: '/reference/api#database' },
      { text: 'Types', link: '/reference/api#types' },
      { text: 'Environment Types', link: '/reference/api#environment-types' },
      { text: 'Framework Adaptors', link: '/reference/api#framework-adaptors' },
      { text: 'Subpath Exports', link: '/reference/api#subpath-exports' },
    ],
  },
];

const referenceLinks = {
  text: 'Reference',
  activeMatch: '/reference/',
  items: referenceItems,
};

const integrationItems = [
  {
    text: 'Meta Frameworks',
    collapsed: false,
    items: [
      { text: 'Overview', link: '/integrations/frameworks/overview' },
      { text: 'TanStack Start', link: '/integrations/frameworks/tanstack-start' },
      { text: 'React Router', link: '/integrations/frameworks/react-router' },
      { text: 'Astro', link: '/integrations/frameworks/astro' },
      { text: 'SvelteKit', link: '/integrations/frameworks/sveltekit' },
      { text: 'Nuxt', link: '/integrations/frameworks/nuxt' },
      { text: 'Analog', link: '/integrations/frameworks/analog' },
    ],
  },
  { text: 'Coding Agents', link: '/integrations/agents' },
  { text: 'Hono', link: '/integrations/hono' },
  { text: 'Cloudflare', link: '/integrations/cloudflare' },
  { text: 'Node.js / Bun / Deno', link: '/integrations/nodejs-bun-deno' },
  { text: 'Payment Processors', link: '/integrations/payment-processors' },
];

const integrationLinks = {
  text: 'Integrations',
  activeMatch: '/integrations/',
  items: integrationItems,
};

const socialLinks = [
  { icon: 'x', link: 'https://x.com/voidcloudhq' },
  { icon: 'discord', link: 'https://discord.gg/cC6TEVFKSx' },
  { icon: 'github', link: 'https://github.com/voidzero-dev/void' },
];

const companyLinks = {
  text: 'Company',
  items: [
    { text: 'Company', link: 'https://voidzero.dev' },
    { text: 'Blog', link: 'https://voidzero.dev/blog' },
    { text: 'Terms of Service', link: 'https://voidzero.dev/legal/terms' },
    { text: 'Privacy Policy', link: 'https://voidzero.dev/legal/privacy' },
    { text: 'Acceptable Use Policy', link: 'https://voidzero.dev/legal/acceptable-use' },
  ],
};

export default extendConfig(
  defineConfig({
    title: 'Void',
    description: 'Build and deploy full-stack Vite apps at warp speed',
    cleanUrls: true,
    head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/icon.svg' }]],
    appearance: 'dark',

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
        provider: 'local',
      },

      nav: [
        { text: 'Guide', link: '/guide/', activeMatch: '/guide/' },
        referenceLinks,
        integrationLinks,
        // { text: "Dashboard", link: "https://dash.void.cloud" },
      ],

      socialLinks,

      sidebar: {
        '/guide/': [
          {
            text: 'Getting Started',
            icon: 'lucide:rocket',
            collapsed: false,
            items: [
              { text: 'Introduction', link: '/guide/' },
              { text: 'Supported App Types', link: '/guide/app-types' },
              { text: 'Quickstart', link: '/guide/quickstart' },
            ],
          },
          {
            text: 'Routing & Rendering',
            // @ts-expect-error
            icon: 'lucide:route',
            collapsed: false,
            items: [
              { text: 'Server Routing', link: '/guide/server-routing' },
              {
                text: 'Pages Routing',
                collapsed: true,
                items: [
                  { text: 'Overview', link: '/guide/pages-routing/overview' },
                  { text: 'Layouts & Shared Data', link: '/guide/pages-routing/layouts' },
                  { text: 'Loaders & Props', link: '/guide/pages-routing/loaders' },
                  { text: 'Actions & Forms', link: '/guide/pages-routing/actions-and-forms' },
                  { text: 'View Transitions', link: '/guide/pages-routing/view-transitions' },
                  { text: 'Head Management', link: '/guide/pages-routing/head' },
                  { text: 'Islands', link: '/guide/pages-routing/islands' },
                  { text: 'Markdown', link: '/guide/pages-routing/markdown' },
                ],
              },
              {
                text: 'Edge Routing',
                collapsed: true,
                items: [
                  { text: 'Static Assets Caching', link: '/guide/edge/static-assets' },
                  { text: 'Revalidation (ISR)', link: '/guide/edge/revalidation' },
                  { text: 'Edge Prerendering', link: '/guide/edge/prerendering' },
                  { text: 'Custom Headers', link: '/guide/edge/headers' },
                  { text: 'Redirects', link: '/guide/edge/redirects' },
                  { text: 'Rewrites', link: '/guide/edge/rewrites' },
                ],
              },
              { text: 'Custom SSR', link: '/guide/ssr' },
              { text: 'SSG', link: '/guide/ssg' },
            ],
          },
          {
            text: 'Data',
            icon: 'lucide:database',
            collapsed: false,
            items: [
              { text: 'Type Safety', link: '/guide/type-safety' },
              {
                text: 'Database',
                collapsed: true,
                items: [
                  { text: 'Overview', link: '/guide/database' },
                  { text: 'D1 (SQLite)', link: '/guide/database/d1' },
                  { text: 'PostgreSQL', link: '/guide/database/postgresql' },
                ],
              },
              { text: 'Typed Fetch', link: '/guide/typed-fetch' },
              { text: 'Key-Value Storage', link: '/guide/kv' },
              { text: 'Object Storage', link: '/guide/storage' },
              { text: 'Environment Variables', link: '/guide/env-vars' },
            ],
          },
          {
            text: 'Platform',
            icon: 'lucide:cloud',
            collapsed: false,
            items: [
              { text: 'AI', link: '/guide/ai' },
              { text: 'Authentication', link: '/guide/auth' },
              { text: 'WebSockets', link: '/guide/websockets' },
              { text: 'Cron Jobs', link: '/guide/jobs' },
              { text: 'Queues', link: '/guide/queues' },
              { text: 'Remote Development', link: '/guide/remote-dev' },
              { text: 'Deployment', link: '/guide/deployment' },
            ],
          },
        ],
        '/integrations/': (() => {
          const frameworkIcons: Record<string, IconOption> = {
            'TanStack Start': 'simple-icons:tanstack',
            'React Router': {
              light: 'logos:react-router',
              dark: 'vscode-icons:file-type-reactrouter',
            },
            Astro: { light: 'logos:astro-icon', dark: 'simple-icons:astro' },
            SvelteKit: 'logos:svelte-icon',
            Nuxt: 'logos:nuxt-icon',
            Analog: 'logos:analog',
          };
          const itemIcons: Record<string, IconOption> = {
            'Coding Agents': 'lucide:bot',
            Hono: 'logos:hono',
            Cloudflare: 'devicon:cloudflare',
            'Node.js / Bun / Deno': 'material-icon-theme:nodejs-alt',
            'Auth Providers': 'lucide:shield',
            'Payment Processors': 'lucide:credit-card',
          };
          return integrationItems.map((item) =>
            item.text === 'Meta Frameworks'
              ? {
                  ...item,
                  icon: 'lucide:blocks',
                  items: item.items?.map((child) => ({
                    ...child,
                    icon: frameworkIcons[child.text],
                  })),
                }
              : { ...item, icon: itemIcons[item.text] },
          );
        })(),
        '/reference/': (() => {
          const icons: Record<string, string> = {
            General: 'lucide:book-open',
            'Project Structure': 'lucide:folder-tree',
            'Resource Inference': 'lucide:scan-search',
            Config: 'lucide:settings',
            API: 'lucide:code',
            CLI: 'lucide:terminal',
          };
          return referenceItems.map((item) => ({
            ...item,
            icon: icons[item.text],
            items: item.items?.map((child) => ({
              ...child,
              icon: icons[child.text] ?? child.icon,
            })),
          }));
        })(),
      },

      footer: {
        nav: [
          {
            title: 'Docs',
            items: [
              { text: 'Guide', link: '/guide/' },
              { text: 'Integrations', link: '/integrations/frameworks/overview' },
              { text: 'Reference', link: '/reference/structure' },
            ],
          },
          {
            title: 'Open Source',
            items: [
              { text: 'Vite', link: 'https://vite.dev' },
              { text: 'Vitest', link: 'https://vitest.dev' },
              { text: 'Rolldown', link: 'https://rolldown.rs' },
              { text: 'Oxc', link: 'https://oxc.rs' },
            ],
          },
          {
            title: companyLinks.text,
            items: companyLinks.items,
          },
        ],
        social: socialLinks,
      },
    },
  }),
);
