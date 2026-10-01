import { stripVTControlCharacters } from 'node:util';
import pc from 'picocolors';

/** The bundled cf login prints the device code before opening the browser. */
export function cloudflareDeviceCode(output: string): string | null {
  const plain = stripVTControlCharacters(output);
  return (
    /and enter the code:\s*([A-Za-z0-9-]+)\s/i.exec(plain)?.[1] ??
    /[?&]user_code=([A-Za-z0-9-]+)\s/i.exec(plain)?.[1] ??
    null
  );
}

export function cloudflareVerificationUrl(output: string): string | null {
  const plain = stripVTControlCharacters(output);
  return (
    /(?:Opening a link in your default browser:|Visit this link to authenticate:)\s*(https?:\/\/\S+)\s/i.exec(
      plain,
    )?.[1] ??
    /please visit:\s*(https?:\/\/\S+)\s/i.exec(plain)?.[1] ??
    null
  );
}

export function printCloudflareLoginLink(url: string): void {
  console.log(`Open this link if your browser did not open: ${url}`);
}

export function printCloudflareLoginPrompt(code: string | null): void {
  console.log(
    code
      ? `Opening Cloudflare login in your browser. Confirm the code ${pc.blue(code)} in your browser. Press Ctrl+C to cancel.`
      : 'Opening Cloudflare login in your browser. Confirm the code shown in your browser. Press Ctrl+C to cancel.',
  );
}
