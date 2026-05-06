import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs';
import { log } from '@clack/prompts';
import { join, relative } from 'pathe';
import { detectAgents, getPackageDir, type AgentConfig } from './agents.ts';

interface SkillInfo {
  dirName: string;
  name: string;
  description: string;
}

function parseSkills(skillsDir: string): Array<SkillInfo> {
  if (!existsSync(skillsDir)) {
    return [];
  }
  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const skills: Array<SkillInfo> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillMd = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(skillMd)) {
      continue;
    }
    const content = readFileSync(skillMd, 'utf-8');
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) {
      continue;
    }
    const nameMatch = frontmatter[1].match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter[1].match(/^description:\s*(.+)$/m);
    skills.push({
      dirName: entry.name,
      name: nameMatch ? nameMatch[1].trim() : entry.name,
      description: descMatch ? descMatch[1].trim() : '',
    });
  }
  return skills;
}

function linkSkills(
  root: string,
  skillsDir: string,
  skills: Array<SkillInfo>,
  agentSkillsDir: string,
): number {
  const targetDir = join(root, agentSkillsDir);
  mkdirSync(targetDir, { recursive: true });

  let linked = 0;
  for (const skill of skills) {
    const linkPath = join(targetDir, skill.dirName);
    const sourcePath = join(skillsDir, skill.dirName);
    const relativeTarget = relative(targetDir, sourcePath);

    if (existsSync(linkPath)) {
      try {
        const existing = readlinkSync(linkPath);
        if (existing === relativeTarget) {
          log.info(`  ${skill.name} — already linked`);
          continue;
        }
      } catch {
        // not a symlink
      }
      log.warn(`  ${skill.name} — path exists but is not the expected symlink, skipping`);
      continue;
    }

    symlinkSync(relativeTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    log.success(`  ${skill.name} — linked`);
    linked++;
  }
  return linked;
}

/**
 * Link skills for all detected agents. Returns total number of newly linked skills.
 * Used by `void init` (interactive flow and `--agents` flag).
 */
export function linkSkillsForAgents(root: string): number {
  const packageDir = getPackageDir();
  const skillsDir = join(packageDir, 'skills');
  const skills = parseSkills(skillsDir);
  if (skills.length === 0) {
    return 0;
  }

  const detected = detectAgents(root);
  if (detected.length === 0) {
    return 0;
  }

  let totalLinked = 0;
  for (const agent of detected) {
    log.info(`${agent.displayName} → ${agent.skillsDir}`);
    totalLinked += linkSkills(root, skillsDir, skills, agent.skillsDir);
  }
  return totalLinked;
}

export function linkSkillsForSpecificAgents(root: string, agents: Array<AgentConfig>): number {
  const packageDir = getPackageDir();
  const skillsDir = join(packageDir, 'skills');
  const skills = parseSkills(skillsDir);
  if (skills.length === 0) {
    return 0;
  }

  if (agents.length === 0) {
    return 0;
  }

  let totalLinked = 0;
  for (const agent of agents) {
    log.info(`${agent.displayName} → ${agent.skillsDir}`);
    totalLinked += linkSkills(root, skillsDir, skills, agent.skillsDir);
  }
  return totalLinked;
}
