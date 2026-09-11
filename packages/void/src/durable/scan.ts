import { existsSync, readdirSync } from 'node:fs';
import { join } from 'pathslash';

export type DurableObjectModule = {
  filePath: string;
  bindingName: string;
  className: string;
  migrationTag: string;
};

const MODULE_PATTERN = /\.(?:[cm]?[jt]s)$/;

function words(value: string): Array<string> {
  return value.split(/[^a-zA-Z0-9]+/).filter(Boolean);
}

export function scanDurableObjectModules(root: string): Array<DurableObjectModule> {
  const directory = join(root, 'durable-objects');
  if (!existsSync(directory)) {
    return [];
  }

  const modules = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && MODULE_PATTERN.test(entry.name) && !entry.name.endsWith('.d.ts'),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const stem = entry.name.replace(MODULE_PATTERN, '');
      const parts = words(stem);
      if (parts.length === 0) {
        throw new Error(`durable: cannot derive a name from durable-objects/${entry.name}.`);
      }
      const classBase = parts.map((part) => part[0].toUpperCase() + part.slice(1)).join('');
      const bindingName = parts.join('_').toUpperCase();
      const slug = parts.join('-').toLowerCase();
      return {
        filePath: join(directory, entry.name),
        bindingName,
        className: `${classBase}DurableObject`,
        migrationTag: `void-durable-${slug}-v1`,
      };
    });

  const bindings = new Set<string>();
  const classes = new Set<string>();
  for (const module of modules) {
    if (bindings.has(module.bindingName) || classes.has(module.className)) {
      throw new Error(
        `durable: duplicate generated name for '${module.filePath}'. Rename one of the durable-objects files.`,
      );
    }
    bindings.add(module.bindingName);
    classes.add(module.className);
  }
  return modules;
}
