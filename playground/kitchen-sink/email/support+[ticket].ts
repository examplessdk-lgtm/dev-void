import { defineEmail, parseEmail, replyEmail } from 'void/email';

/**
 * Inbound handler for `support+<ticket>@<sender-domain>`.
 *
 * Demonstrates the full inbound lifecycle:
 *   - dynamic param capture (info.params.ticket)
 *   - parseEmail for the parsed body / subject
 *   - replyEmail with threading-aware reply MIME (In-Reply-To / References / Re:)
 *
 * To try it locally, deliver a test message with `createInboundTestHarness`
 * from `void/email/testing`.
 */
export default defineEmail(async (message, _env, _ctx, info) => {
  const ticket = info?.params.ticket ?? 'unknown';
  const parsed = await parseEmail(message);

  console.log(`[email] ticket=${ticket} from=${message.from} subject=${parsed.subject ?? ''}`);

  await replyEmail(message, {
    text:
      `Hi! Your message on ticket ${ticket} was received.\n\n` +
      `We logged the subject: "${parsed.subject ?? ''}"`,
  });
});
