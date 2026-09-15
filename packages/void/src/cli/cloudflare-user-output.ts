/**
 * Keep Void's public CLI vocabulary at the product level while preserving real
 * Cloudflare config filenames and environment variables that users may need to
 * inspect. The underlying implementation remains available in source and deploy
 * diagnostics, but normal remediation always points back to Void commands.
 */
export function formatCloudflareUserMessage(message: string): string {
  const preserved: Array<string> = [];
  const protect = (value: string): string => {
    const index = preserved.push(value) - 1;
    return `\uE000VOID_CF_TERM_${index}\uE001`;
  };

  let result = message
    .replace(/(?:[A-Za-z]:)?[^\s`"']*wrangler\.jsonc?/gi, protect)
    .replace(/\bWRANGLER_[A-Z0-9_]+\b/g, protect)
    .replace(/\.wrangler\b/gi, protect)
    .replace(/`wrangler deploy`/gi, '`void deploy --platform cloudflare`')
    .replace(/`wrangler secret list[^`]*`/gi, '`void secret list`')
    .replace(/`wrangler secret put\s+([^`]*)`/gi, '`void secret put $1`')
    .replace(/`wrangler d1 migrations apply[^`]*`/gi, '`void db migrate --remote`')
    .replace(/`wrangler d1 migrations list[^`]*`/gi, '`void db status`')
    .replace(/`wrangler[^`]*`/gi, 'the underlying Cloudflare operation')
    .replace(/"wrangler[^"\n]*"/gi, '"Cloudflare operation"')
    .replace(/\bwrangler uploader\b/gi, 'Cloudflare deployment tool')
    .replace(/\bwrangler (?:CLI|binary|process|child)\b/gi, 'Cloudflare deployment tool')
    .replace(/\bwrangler config\b/gi, 'Cloudflare config')
    .replace(/\bwrangler\b/gi, 'Cloudflare tooling');

  result = result.replace(/\uE000VOID_CF_TERM_(\d+)\uE001/g, (_match, index: string) => {
    return preserved[Number(index)] ?? '';
  });
  return result;
}
