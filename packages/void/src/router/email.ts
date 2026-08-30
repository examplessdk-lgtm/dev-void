/**
 * Scan `email/` for inbound email handlers.
 *
 * The `email/` directory sits at the project root alongside `crons/` and
 * `queues/` — non-HTTP handlers all live at the top level, since each is
 * wired into a separate worker export (`scheduled`, `queue`, `email`).
 *
 *   email/<local-part>.ts        per-recipient handler matched against the
 *                                 local-part of the To address
 *   email/<local-part>+[tag].ts  same, with a `+suffix` capture exposed as
 *                                 `info.params.<tag>`
 *   email/[name].ts              dynamic local-part — captures the whole
 *                                 local-part as `info.params.<name>`
 *   email/[name]+[tag].ts        dynamic + tag
 *   email/_default.ts            fallback when no per-address pattern matches
 *
 * Match precedence (most specific wins):
 *   static + tag → static → dynamic + tag → dynamic → _default
 *
 * Local-part matching is case-insensitive: the compiled patterns carry the `i`
 * flag and run against the recipient in its original case, so a captured tag
 * such as a ticket id keeps the case it arrived with. Nested folders are
 * intentionally ignored — the recipient address is a single string, not a path.
 */

import { join } from 'pathslash';
import { glob, globSync } from 'tinyglobby';

const EMAIL_EXTENSIONS = ['ts', 'mts', 'js', 'mjs'];

/** Token identifies a single segment of the local-part pattern (before/after the `+`). */
type Segment = { kind: 'literal'; value: string } | { kind: 'param'; name: string };

export type EmailPatternKind = 'static' | 'static-tag' | 'dynamic' | 'dynamic-tag';

export interface CompiledEmailPattern {
  kind: EmailPatternKind;
  /** Regex source (anchored), targeting the lowercased local-part. */
  regexSource: string;
  /** Capture-group names in order; empty for `static`. */
  paramNames: Array<string>;
}

export interface EmailHandlerDefinition {
  /** Original basename without extension, e.g. "support" or "support+[ticket]". */
  address: string;
  /** Path relative to the email directory, e.g. "support.ts". */
  filePath: string;
  /** Compiled match pattern. */
  pattern: CompiledEmailPattern;
}

export interface EmailHandlersScan {
  /** Per-address handlers under email/, sorted by specificity then name. */
  addresses: Array<EmailHandlerDefinition>;
  /** email/_default.<ext> — fires when no per-address pattern matches. */
  defaultHandler?: string;
}

const PARAM_RE = /^\[([a-z][a-z0-9]*)\]$/;
const LITERAL_RE = /^[a-z0-9._-]+$/;

function compileSegment(part: string): Segment | null {
  const param = PARAM_RE.exec(part);
  if (param) {
    return { kind: 'param', name: param[1] };
  }
  if (!LITERAL_RE.test(part)) {
    return null;
  }
  return { kind: 'literal', value: part };
}

function escapeLiteral(value: string): string {
  // Of the allowed literal chars `[a-z0-9._-]`, only `.` is regex-meaningful.
  return value.replace(/\./g, '\\.');
}

function segmentRegex(s: Segment): string {
  return s.kind === 'literal' ? escapeLiteral(s.value) : '([^+@]+)';
}

function patternKind(prefix: Segment, tag?: Segment): EmailPatternKind {
  const prefixDynamic = prefix.kind === 'param';
  if (tag) {
    return prefixDynamic ? 'dynamic-tag' : 'static-tag';
  }
  return prefixDynamic ? 'dynamic' : 'static';
}

/**
 * Compile a basename like `support`, `support+[ticket]`, `[user]`, or
 * `[user]+[tag]` into a match pattern, or return `null` if the basename
 * uses characters or shapes outside the supported grammar.
 */
export function compileEmailPattern(basename: string): CompiledEmailPattern | null {
  const lower = basename.toLowerCase();
  // We allow at most one `+` separator (subaddress tag). Anything else is invalid.
  const parts = lower.split('+');
  if (parts.length > 2) {
    return null;
  }
  const prefix = compileSegment(parts[0] ?? '');
  if (!prefix) {
    return null;
  }
  let tag: Segment | undefined;
  if (parts.length === 2) {
    const compiled = compileSegment(parts[1] ?? '');
    if (!compiled) {
      return null;
    }
    tag = compiled;
  }

  const paramNames: Array<string> = [];
  if (prefix.kind === 'param') {
    paramNames.push(prefix.name);
  }
  if (tag?.kind === 'param') {
    paramNames.push(tag.name);
  }
  if (new Set(paramNames).size !== paramNames.length) {
    const dupes = paramNames.filter((n, i) => paramNames.indexOf(n) !== i);
    throw new Error(
      `email handler "${basename}" has duplicate param names: ${dupes.join(', ')}. Each [name] segment must be unique within a single handler filename.`,
    );
  }

  const segments: Array<string> = [segmentRegex(prefix)];
  if (tag) {
    segments.push('\\+', segmentRegex(tag));
  }
  return {
    kind: patternKind(prefix, tag),
    regexSource: `^${segments.join('')}$`,
    paramNames,
  };
}

const SPECIFICITY: Record<EmailPatternKind, number> = {
  static: 0,
  'static-tag': 1,
  dynamic: 2,
  'dynamic-tag': 3,
};

/**
 * Final dispatch order: most specific first. Within a specificity bucket,
 * static-tag beats static (more constraints), dynamic-tag beats dynamic.
 * The order below matches the precedence list in the file header.
 */
const DISPATCH_ORDER: Record<EmailPatternKind, number> = {
  'static-tag': 0,
  static: 1,
  'dynamic-tag': 2,
  dynamic: 3,
};

function parseEmailFiles(files: Array<string>): {
  addresses: Array<EmailHandlerDefinition>;
  defaultHandler?: string;
} {
  const addresses: Array<EmailHandlerDefinition> = [];
  let defaultHandler: string | undefined;

  for (const filePath of files) {
    if (filePath.includes('/')) {
      continue;
    }
    const basename = filePath.replace(/\.[^.]+$/, '');
    if (basename === '_default') {
      defaultHandler = filePath;
      continue;
    }
    if (basename.startsWith('_')) {
      continue;
    }
    const pattern = compileEmailPattern(basename);
    if (!pattern) {
      continue;
    }
    addresses.push({
      address: basename.toLowerCase(),
      filePath,
      pattern,
    });
  }

  addresses.sort((a, b) => {
    const da = DISPATCH_ORDER[a.pattern.kind];
    const db = DISPATCH_ORDER[b.pattern.kind];
    if (da !== db) {
      return da - db;
    }
    // Same kind — keep deterministic alphabetical order.
    return a.address.localeCompare(b.address);
  });

  // Two handlers can compile to the same regex source — the obvious case
  // is `[user].ts` and `[other].ts` both producing `^([^+@]+)$`. After
  // alphabetical sort, the first one wins for every delivery and the
  // others are dead code. Reject at scan time with a clear error rather
  // than letting the deployment ship a silent footgun.
  const seenRegex = new Map<string, string>();
  for (const def of addresses) {
    const prior = seenRegex.get(def.pattern.regexSource);
    if (prior !== undefined) {
      throw new Error(
        `email handler "${def.filePath}" matches the same address shape as "${prior}" (both compile to ${def.pattern.regexSource}). Rename one of them — only the alphabetically-first would ever fire.`,
      );
    }
    seenRegex.set(def.pattern.regexSource, def.filePath);
  }

  return { addresses, defaultHandler };
}

export async function scanEmailHandlers(
  root: string,
  emailDir = 'email',
): Promise<EmailHandlersScan> {
  const pattern = `*.{${EMAIL_EXTENSIONS.join(',')}}`;
  const files = await glob(pattern, {
    cwd: join(root, emailDir),
    absolute: false,
  }).catch(() => [] as Array<string>);
  return parseEmailFiles(files);
}

export function scanEmailHandlersSync(root: string, emailDir = 'email'): EmailHandlersScan {
  const pattern = `*.{${EMAIL_EXTENSIONS.join(',')}}`;
  let files: Array<string>;
  try {
    files = globSync(pattern, { cwd: join(root, emailDir), absolute: false });
  } catch {
    files = [];
  }
  return parseEmailFiles(files);
}

export function hasEmailHandlers(scan: EmailHandlersScan): boolean {
  return scan.addresses.length > 0 || Boolean(scan.defaultHandler);
}

// SPECIFICITY is exported for tests/tooling that want to inspect ordering.
export { SPECIFICITY };
