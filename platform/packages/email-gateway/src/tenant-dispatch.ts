import {
  EMAIL_PROTOCOL_VERSION,
  EMAIL_RECEIPT_PATH,
  encodeEmailEnvelope,
  readEmailActions,
  signEmailReceipt,
  type EmailWireAction,
  type EmailWireEnvelope,
} from '@void/platform/email-protocol';

const MAX_CONCURRENT_PER_PROJECT = 8;
const active = new Map<string, number>();

export async function dispatchBoundedEmailToTenant(
  stub: Pick<Fetcher, 'fetch'>,
  env: { JWT_SECRET: string },
  input: {
    projectId: string;
    deploymentId: string;
    envelope: EmailWireEnvelope;
    receiptId: string;
  },
): Promise<{ actions: Array<EmailWireAction>; receiptId: string }> {
  if (!input.deploymentId || !input.projectId) {
    throw new Error('email deployment identity missing');
  }
  const receiptId = input.receiptId;
  if (!/^[a-f0-9-]{16,64}$/.test(receiptId)) {
    throw new Error('invalid email receipt ID');
  }
  const count = active.get(input.projectId) ?? 0;
  if (count >= MAX_CONCURRENT_PER_PROJECT) {
    throw new Error('email project concurrency exceeded');
  }
  active.set(input.projectId, count + 1);
  try {
    const receipt = await signEmailReceipt(
      {
        version: EMAIL_PROTOCOL_VERSION,
        receiptId,
        projectId: input.projectId,
        deploymentId: input.deploymentId,
        recipient: input.envelope.to,
        expiresAt: Date.now() + 30_000,
      },
      env.JWT_SECRET,
    );
    const response = await stub.fetch(`https://worker${EMAIL_RECEIPT_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.void.email-envelope; version=1',
        'x-void-email-receipt': receipt,
        'x-void-email-recipient': input.envelope.to,
      },
      body: encodeEmailEnvelope(input.envelope),
      signal: AbortSignal.timeout(20_000),
    });
    if (
      !response.ok ||
      response.headers.get('content-encoding') ||
      response.headers.get('content-type') !==
        `application/vnd.void.email-actions; version=${EMAIL_PROTOCOL_VERSION}` ||
      !response.body
    ) {
      throw new Error(`invalid email tenant response (${response.status})`);
    }
    const actions = await readEmailActions(response.body, 15_000);
    return { actions, receiptId };
  } finally {
    const remaining = (active.get(input.projectId) ?? 1) - 1;
    if (remaining === 0) {
      active.delete(input.projectId);
    } else {
      active.set(input.projectId, remaining);
    }
  }
}
