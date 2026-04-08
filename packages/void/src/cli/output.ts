import pc from 'picocolors';

export { pc };

export function cliTitle(command: string): string {
  return pc.blue(`void ${command}`);
}

export function sectionTitle(title: string): string {
  return pc.reset(pc.blue(title));
}

export function categoryTitle(title: string): string {
  return pc.reset(pc.bold(pc.cyan(title)));
}

export function dim(text: string): string {
  return pc.dim(text);
}

export function tablePrefix(): string {
  return `${pc.gray('│')}  `;
}

export function helpLine(command: string, description: string): string {
  return `${pc.reset(command.padEnd(34))} ${pc.dim(description)}`;
}

/**
 * Ensure a timestamp string will be parsed as UTC by `new Date()`.
 * DB timestamps lack timezone info — appends 'Z' only when no
 * existing indicator (Z, z, or numeric offset) is present.
 */
export function ensureUtc(s: string): string {
  const last = s.at(-1);
  if (last === 'Z' || last === 'z') {
    return s;
  }
  if (s.includes('+', 10)) {
    return s;
  }
  if (s.lastIndexOf('-') > 9) {
    return s;
  }
  return s + 'Z';
}
