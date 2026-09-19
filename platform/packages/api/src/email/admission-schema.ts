import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { projects } from '../schema.ts';

export const emailProjectControls = pgTable('email_project_controls', {
  project_id: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  monthly_limit: integer('monthly_limit').notNull().default(200),
  burst_limit: integer('burst_limit').notNull().default(10),
  suspended_at: timestamp('suspended_at', { mode: 'string', withTimezone: true }),
  version: integer('version').notNull().default(1),
});

/** Quota history outlives the 30-day delivery ledger through month end. */
export const emailMonthlyUsage = pgTable(
  'email_monthly_usage',
  {
    project_id: text('project_id').notNull(),
    month: text('month').notNull(),
    recipient_attempts: integer('recipient_attempts').notNull().default(0),
    inbound_receipts: integer('inbound_receipts').notNull().default(0),
  },
  (table) => [
    unique('email_monthly_usage_project_month_uq').on(table.project_id, table.month),
    check('email_monthly_usage_nonnegative_check', sql`${table.recipient_attempts} >= 0`),
    check('email_monthly_usage_inbound_nonnegative_check', sql`${table.inbound_receipts} >= 0`),
  ],
);

export const emailReceipts = pgTable(
  'email_receipts',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id').notNull(),
    status: text('status').notNull().default('received'),
    payload_digest: text('payload_digest'),
    final_reject: boolean('final_reject'),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('idx_email_receipts_project_created').on(table.project_id, table.created_at)],
);

export const emailActions = pgTable(
  'email_actions',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id').notNull(),
    sender_domain: text('sender_domain').notNull(),
    receipt_id: text('receipt_id').references(() => emailReceipts.id, { onDelete: 'set null' }),
    kind: text('kind').notNull().$type<'direct' | 'forward' | 'reply'>(),
    idempotency_key: text('idempotency_key').notNull(),
    payload_digest: text('payload_digest').notNull(),
    transport: text('transport').notNull(),
    policy_version: integer('policy_version').notNull(),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('email_actions_project_key_uq').on(table.project_id, table.idempotency_key),
    index('idx_email_actions_project_created').on(table.project_id, table.created_at),
    check('email_actions_kind_check', sql`${table.kind} IN ('direct', 'forward', 'reply')`),
  ],
);

export const emailActionRecipients = pgTable(
  'email_action_recipients',
  {
    id: text('id').primaryKey(),
    action_id: text('action_id')
      .notNull()
      .references(() => emailActions.id, { onDelete: 'cascade' }),
    project_id: text('project_id').notNull(),
    recipient: text('recipient').notNull(),
    state: text('state')
      .notNull()
      .$type<
        | 'rejected'
        | 'reserved'
        | 'attempt_started'
        | 'provider_accepted'
        | 'failed'
        | 'outcome_unknown'
        | 'cancelled'
      >(),
    error_code: text('error_code'),
    provider_reference: text('provider_reference'),
    reserved_at: timestamp('reserved_at', { mode: 'string', withTimezone: true }),
    attempt_started_at: timestamp('attempt_started_at', { mode: 'string', withTimezone: true }),
    completed_at: timestamp('completed_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [
    unique('email_action_recipients_action_recipient_uq').on(table.action_id, table.recipient),
    index('idx_email_action_recipients_project_reserved').on(table.project_id, table.reserved_at),
    index('idx_email_action_recipients_expiring')
      .on(table.reserved_at)
      .where(sql`${table.state} = 'reserved'`),
    check(
      'email_action_recipients_state_check',
      sql`${table.state} IN ('rejected', 'reserved', 'attempt_started', 'provider_accepted', 'failed', 'outcome_unknown', 'cancelled')`,
    ),
  ],
);

/** PII-free fence retained if an active provider attempt outlives log retention. */
export const emailUnresolvedAttempts = pgTable(
  'email_unresolved_attempts',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id').notNull(),
    sender_domain: text('sender_domain').notNull(),
    started_at: timestamp('started_at', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_email_unresolved_attempts_project').on(table.project_id),
    index('idx_email_unresolved_attempts_domain').on(table.sender_domain),
  ],
);
