import { tokenizeSql } from '../sql/tokenize.ts';
import { canonicalJson } from './canonical-json.ts';

export const MIGRATION_CLASSIFIER_VERSION = 1;

const UNSPLIT_MULTI_STATEMENT_PRAGMA = '-- void:allow-unsplit-multi-statement';

export type ServerMigrationPlan = {
  name: string;
  dialect: 'sqlite';
  classifierVersion: number;
  sqlHash: string;
  planHash: string;
  stability: 'stable' | 'legacy';
} & (
  | { kind: 'single-statement' }
  | { kind: 'breakpoint-framed'; statements: Array<string> }
  | { kind: 'legacy-unsplit-multi-statement'; allowLegacy: boolean }
);

type ServerMigrationPlanWithoutHash =
  | Omit<Extract<ServerMigrationPlan, { kind: 'single-statement' }>, 'planHash'>
  | Omit<Extract<ServerMigrationPlan, { kind: 'breakpoint-framed' }>, 'planHash'>
  | Omit<Extract<ServerMigrationPlan, { kind: 'legacy-unsplit-multi-statement' }>, 'planHash'>;

export async function validateSubmittedExecutionPlans(
  migrations: ReadonlyArray<{ name: string; sql: string }>,
  plans: ReadonlyArray<Record<string, unknown>> | undefined,
): Promise<string | null> {
  if (plans === undefined) {
    return null;
  }
  if (!Array.isArray(plans) || plans.length !== migrations.length) {
    return 'executionPlans must match migrations length';
  }
  for (let index = 0; index < migrations.length; index++) {
    const migration = migrations[index]!;
    const plan = plans[index]!;
    if (plan.name !== migration.name) {
      return `executionPlans[${index}].name must match migrations[${index}].name`;
    }
    if (plan.dialect !== 'sqlite') {
      return `executionPlans[${index}].dialect must be sqlite`;
    }
    if (plan.classifierVersion !== MIGRATION_CLASSIFIER_VERSION) {
      return `executionPlans[${index}].classifierVersion is unsupported`;
    }
    const serverPlan = await classifyServerMigrationPlan(migration);
    if (plan.sqlHash !== serverPlan.sqlHash) {
      return `executionPlans[${index}].sqlHash does not match migration SQL`;
    }
    const kind = plan.kind;
    if (
      kind !== 'single-statement' &&
      kind !== 'breakpoint-framed' &&
      kind !== 'legacy-unsplit-multi-statement'
    ) {
      return `executionPlans[${index}].kind is unsupported`;
    }
    if (kind !== serverPlan.kind) {
      return `executionPlans[${index}].kind does not match server classification`;
    }
    if (plan.stability !== serverPlan.stability) {
      return `executionPlans[${index}].stability does not match server classification`;
    }
    const hashInput: Record<string, unknown> = {
      classifierVersion: plan.classifierVersion,
      dialect: plan.dialect,
      kind,
      name: plan.name,
      sqlHash: plan.sqlHash,
      stability: plan.stability,
    };
    if (kind === 'breakpoint-framed') {
      const serverStatements = serverPlan.kind === 'breakpoint-framed' ? serverPlan.statements : [];
      if (
        !Array.isArray(plan.statements) ||
        !plan.statements.every((value: unknown) => typeof value === 'string')
      ) {
        return `executionPlans[${index}].statements must be an array of strings`;
      }
      if (
        plan.statements.length !== serverStatements.length ||
        plan.statements.some((statement: string, statementIndex: number) => {
          return statement !== serverStatements[statementIndex];
        })
      ) {
        return `executionPlans[${index}].statements do not match server classification`;
      }
      hashInput.statements = plan.statements;
    } else if ('statements' in plan) {
      return `executionPlans[${index}].statements are only allowed for breakpoint-framed plans`;
    }
    const planHash = await sha256Hex(canonicalJson(hashInput));
    if (plan.planHash !== planHash) {
      return `executionPlans[${index}].planHash does not match plan contents`;
    }
    if (plan.planHash !== serverPlan.planHash) {
      return `executionPlans[${index}].planHash does not match server classification`;
    }
  }
  return null;
}

export function canonicalSql(sql: string): string {
  const withoutBom = sql.charCodeAt(0) === 0xfeff ? sql.slice(1) : sql;
  return withoutBom.replace(/\r\n?/g, '\n');
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function isBreakpointComment(text: string): boolean {
  return text.trim() === '--> statement-breakpoint';
}

function splitBreakpointFramedSql(sql: string): Array<string> {
  const normalized = canonicalSql(sql);
  const statements: Array<string> = [];
  let cursor = 0;

  for (const segment of tokenizeSql(normalized)) {
    if (segment.kind !== 'line-comment') {
      continue;
    }
    const comment = normalized.slice(segment.start, segment.end);
    if (isBreakpointComment(comment)) {
      const statement = normalized.slice(cursor, segment.start).trim();
      if (statement) {
        statements.push(statement);
      }
      cursor = segment.end;
    }
  }

  const statement = normalized.slice(cursor).trim();
  if (statement) {
    statements.push(statement);
  }
  return statements;
}

function hasStatementBreakpointOutsideLiterals(sql: string): boolean {
  const normalized = canonicalSql(sql);
  for (const segment of tokenizeSql(normalized)) {
    if (segment.kind !== 'line-comment') {
      continue;
    }
    const comment = normalized.slice(segment.start, segment.end);
    if (isBreakpointComment(comment)) {
      return true;
    }
  }
  return false;
}

export function isSingleStatement(sql: string): boolean {
  const normalized = canonicalSql(sql);
  let statements = 0;
  let inStatement = false;

  for (const segment of tokenizeSql(normalized)) {
    if (segment.kind === 'line-comment' || segment.kind === 'block-comment') {
      continue;
    }
    if (segment.kind === 'string' || segment.kind === 'ident-quote') {
      inStatement = true;
      continue;
    }
    for (let index = segment.start; index < segment.end; index++) {
      const character = normalized[index];
      if (character === ';') {
        if (inStatement) {
          statements++;
          inStatement = false;
        }
        continue;
      }
      if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') {
        inStatement = true;
      }
    }
  }

  if (inStatement) {
    statements++;
  }
  return statements === 1;
}

function hasStandalonePragma(sql: string, pragma: string): boolean {
  return canonicalSql(sql)
    .split('\n')
    .some((line) => line.trim() === pragma);
}

function getPlanHashInput(plan: ServerMigrationPlan | ServerMigrationPlanWithoutHash): unknown {
  const base: Record<string, unknown> = {
    classifierVersion: plan.classifierVersion,
    dialect: plan.dialect,
    kind: plan.kind,
    name: plan.name,
    sqlHash: plan.sqlHash,
    stability: plan.stability,
  };
  if (plan.kind === 'breakpoint-framed') {
    base.statements = plan.statements;
  }
  return base;
}

export async function classifyServerMigrationPlan(migration: {
  name: string;
  sql: string;
}): Promise<ServerMigrationPlan> {
  const sql = canonicalSql(migration.sql);
  const sqlHash = await sha256Hex(sql);
  const common = {
    classifierVersion: MIGRATION_CLASSIFIER_VERSION,
    dialect: 'sqlite' as const,
    name: migration.name,
    sqlHash,
  };
  let planWithoutHash: ServerMigrationPlanWithoutHash;
  if (hasStatementBreakpointOutsideLiterals(sql)) {
    const statements = splitBreakpointFramedSql(sql);
    planWithoutHash = {
      ...common,
      kind: 'breakpoint-framed',
      stability: 'stable',
      statements,
    };
  } else if (isSingleStatement(sql)) {
    planWithoutHash = {
      ...common,
      kind: 'single-statement',
      stability: 'stable',
    };
  } else {
    planWithoutHash = {
      ...common,
      allowLegacy: hasStandalonePragma(sql, UNSPLIT_MULTI_STATEMENT_PRAGMA),
      kind: 'legacy-unsplit-multi-statement',
      stability: 'legacy',
    };
  }

  const plan = {
    ...planWithoutHash,
    planHash: await sha256Hex(canonicalJson(getPlanHashInput(planWithoutHash))),
  } as ServerMigrationPlan;
  return plan;
}
