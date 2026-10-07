// eslint-disable-next-line no-control-regex -- matching control characters is the point
const SGR_OR_CONTROL = /\u001b\[[0-9;]*m|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Make app log text safe to print to a terminal. App logs often echo request
 * data from anonymous visitors, so escape sequences in them must not reach the
 * terminal as commands (clipboard writes, hyperlinks, screen clears, cursor
 * moves or carriage-return overwrites).
 *
 * SGR color codes, newlines and tabs are kept so ordinary colored or
 * multi-line logs read the same. A text that keeps any SGR code ends with a
 * reset, so styles such as conceal cannot hide the lines printed after it.
 * Every other C0/C1 control character is dropped, which turns any other escape
 * sequence into plain text.
 *
 * Keep this module free of imports: the Cloudflare operation process is a
 * separate bundle entry that must stay small.
 */
export function sanitizeTerminalLogText(value: string): string {
  let keptStyle = false;
  const text = value.replace(SGR_OR_CONTROL, (match) => {
    if (match.length === 1) {
      return '';
    }
    keptStyle = true;
    return match;
  });
  return keptStyle ? `${text}\u001b[0m` : text;
}
