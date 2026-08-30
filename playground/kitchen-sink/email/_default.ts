import { defineEmail } from 'void/email';

/**
 * Fallback for any inbound message that doesn't match a per-address handler.
 * Quietly rejects so unknown recipients get a non-delivery notice rather
 * than silently disappearing.
 */
export default defineEmail(async (message) => {
  console.log(`[email] unhandled to=${message.to} from=${message.from}`);
  message.setReject(`No handler for ${message.to}`);
});
