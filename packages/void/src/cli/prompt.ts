import { select, text, isCancel, cancel } from '@clack/prompts';
import { getSiteDomain } from './auth.ts';
import type { ProjectResponse } from './client.ts';

interface SelectResult {
  action: 'select';
  project: ProjectResponse;
}

interface CreateResult {
  action: 'create';
}

export type PromptResult = SelectResult | CreateResult;
export type ProjectSetupAction = 'create' | 'link';

export async function promptProjectSetupAction(
  message = 'Set up a Void project:',
  options: { includeLink?: boolean } = {},
): Promise<ProjectSetupAction> {
  const result = await select({
    message,
    options: [
      { value: 'create', label: 'Create a new project' },
      ...(options.includeLink === false
        ? []
        : [{ value: 'link', label: 'Link an existing project' }]),
    ],
  });

  if (isCancel(result)) {
    cancel('Deploy cancelled.');
    process.exit(0);
  }

  return result as ProjectSetupAction;
}

export async function promptProjectSelection(
  projects: Array<ProjectResponse>,
  message = 'Select a project:',
  root: string = process.cwd(),
  options: { includeCreate?: boolean } = {},
): Promise<PromptResult> {
  const choices = [
    ...(options.includeCreate === false
      ? []
      : [{ value: '__create__', label: 'Create new project' }]),
    ...projects.map((p) => ({
      value: p.id,
      label: `${p.slug} (${p.slug}.${getSiteDomain(root)})`,
    })),
  ];

  const result = await select({
    message,
    options: choices,
  });

  if (isCancel(result)) {
    cancel('Deploy cancelled.');
    process.exit(0);
  }

  if (result === '__create__') {
    return { action: 'create' };
  }

  const project = projects.find((p) => p.id === result)!;
  return { action: 'select', project };
}

export async function promptProjectSlug(defaultSlug: string): Promise<string> {
  const result = await text({
    message: 'Choose a slug for your new Void project:',
    placeholder: 'my-app',
    initialValue: defaultSlug,
    validate(value) {
      const slug = (value ?? '').trim();
      if (slug.length === 0) {
        return 'Project slug is required.';
      }

      // Allows lowercase alphanumeric with interior dashes.
      const valid =
        slug.length === 1 ? /^[a-z0-9]$/.test(slug) : /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug);
      if (!valid) {
        return 'Slug must be lowercase alphanumeric with dashes.';
      }

      return undefined;
    },
  });

  if (isCancel(result)) {
    cancel('Deploy cancelled.');
    process.exit(0);
  }

  return result.trim();
}
