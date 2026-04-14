import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function getPackageDir(): string {
  let dir = join(fileURLToPath(import.meta.url), '..');
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      if (pkg.name === 'void' || pkg.name === '@void-sdk/void') {
        return dir;
      }
    }
    dir = join(dir, '..');
  }
  throw new Error('Could not find void package root');
}

export interface McpConfigTarget {
  /** Config file path relative to project root, e.g. ".claude/settings.json" */
  filePath: string;
  /** JSON key that holds MCP server entries, e.g. "mcpServers" or "servers" */
  rootKey: string;
  /** Extra fields merged into the server entry, e.g. { type: "stdio" } for VS Code */
  extraFields?: Record<string, string>;
}

// Agent configs: project-local skillsDir and how to detect presence in the project root.
// Skill directory locations are aligned with:
// https://github.com/vercel-labs/skills/blob/main/README.md
export interface AgentConfig {
  displayName: string;
  skillsDir: string;
  detect: (root: string) => boolean;
  /** Project-level config files where MCP server entries can be auto-written */
  mcpConfig?: McpConfigTarget[];
  /** Fallback hint printed when the agent has no project-level config support */
  mcpHint?: string;
}

const agents: Record<string, AgentConfig> = {
  'claude-code': {
    displayName: 'Claude Code',
    skillsDir: '.claude/skills',
    detect: (root) => existsSync(join(root, '.claude')) || existsSync(join(root, 'CLAUDE.md')),
    mcpConfig: [
      { filePath: '.claude/settings.json', rootKey: 'mcpServers' },
      { filePath: '.claude/settings.local.json', rootKey: 'mcpServers' },
    ],
  },
  amp: {
    displayName: 'Amp',
    skillsDir: '.agents/skills',
    detect: (root) => existsSync(join(root, '.agents')),
    mcpHint:
      "Run `npx void mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  codex: {
    displayName: 'Codex',
    skillsDir: '.agents/skills',
    detect: (root) => existsSync(join(root, '.codex')),
    mcpHint: 'codex mcp add void -- npx void mcp',
  },
  cursor: {
    displayName: 'Cursor',
    skillsDir: '.agents/skills',
    detect: (root) => existsSync(join(root, '.cursor')),
    mcpConfig: [{ filePath: '.cursor/mcp.json', rootKey: 'mcpServers' }],
  },
  windsurf: {
    displayName: 'Windsurf',
    skillsDir: '.windsurf/skills',
    detect: (root) => existsSync(join(root, '.windsurf')),
    mcpConfig: [{ filePath: '.windsurf/mcp.json', rootKey: 'mcpServers' }],
  },
  'gemini-cli': {
    displayName: 'Gemini CLI',
    skillsDir: '.agents/skills',
    detect: (root) => existsSync(join(root, '.gemini')),
    mcpHint: 'gemini mcp add void -- npx void mcp',
  },
  'github-copilot': {
    displayName: 'GitHub Copilot',
    skillsDir: '.agents/skills',
    detect: (root) =>
      existsSync(join(root, '.github', 'copilot-instructions.md')) ||
      existsSync(join(root, '.vscode', 'mcp.json')),
    mcpConfig: [
      { filePath: '.vscode/mcp.json', rootKey: 'servers', extraFields: { type: 'stdio' } },
    ],
  },
  cline: {
    displayName: 'Cline',
    skillsDir: '.cline/skills',
    detect: (root) => existsSync(join(root, '.cline')),
    mcpHint:
      "Run `npx void mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  roo: {
    displayName: 'Roo Code',
    skillsDir: '.roo/skills',
    detect: (root) => existsSync(join(root, '.roo')),
    mcpConfig: [{ filePath: '.roo/mcp.json', rootKey: 'mcpServers' }],
  },
  kilo: {
    displayName: 'Kilo Code',
    skillsDir: '.kilocode/skills',
    detect: (root) => existsSync(join(root, '.kilocode')),
    mcpHint:
      "Run `npx void mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  continue: {
    displayName: 'Continue',
    skillsDir: '.continue/skills',
    detect: (root) => existsSync(join(root, '.continue')),
    mcpHint:
      "Run `npx void mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  goose: {
    displayName: 'Goose',
    skillsDir: '.goose/skills',
    detect: (root) => existsSync(join(root, '.goose')),
    mcpHint:
      "Run `npx void mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  opencode: {
    displayName: 'OpenCode',
    skillsDir: '.agents/skills',
    detect: (root) => existsSync(join(root, '.opencode')),
    mcpHint:
      "Run `npx void mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  trae: {
    displayName: 'Trae',
    skillsDir: '.trae/skills',
    detect: (root) => existsSync(join(root, '.trae')),
    mcpHint:
      "Run `npx void mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  junie: {
    displayName: 'Junie',
    skillsDir: '.junie/skills',
    detect: (root) => existsSync(join(root, '.junie')),
    mcpHint:
      "Run `npx void mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  'kiro-cli': {
    displayName: 'Kiro CLI',
    skillsDir: '.kiro/skills',
    detect: (root) => existsSync(join(root, '.kiro')),
    mcpHint:
      "Run `npx void mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  zencoder: {
    displayName: 'Zencoder',
    skillsDir: '.zencoder/skills',
    detect: (root) => existsSync(join(root, '.zencoder')),
    mcpHint:
      "Run `npx void mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
  'qwen-code': {
    displayName: 'Qwen Code',
    skillsDir: '.qwen/skills',
    detect: (root) => existsSync(join(root, '.qwen')),
    mcpHint:
      "Run `npx void mcp` — this starts a stdio MCP server. See your agent's docs for how to add a local MCP server.",
  },
};

export function getAgentById(id: string): AgentConfig | undefined {
  return agents[id];
}

export function detectAgents(root: string): AgentConfig[] {
  return Object.values(agents).filter((a) => a.detect(root));
}
