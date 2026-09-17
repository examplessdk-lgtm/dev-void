// File-backed stand-in for the bundled CLI. Identities are synthetic; no OAuth,
// keychain, or network access occurs. Storage selection models Wrangler's
// encrypted-first read and its persistent keyring preference.
import { readFileSync, writeFileSync } from 'node:fs';
const filename = 'auth-fixture.json';
const state = JSON.parse(readFileSync(filename, 'utf8'));
const args = process.argv.slice(2);
state.commands.push(args);
const save = () => writeFileSync(filename, JSON.stringify(state));
const finish = (value, status = 0) => {
  save();
  if (value !== undefined) {
    process.stdout.write(JSON.stringify(value));
  }
  process.exit(status);
};
const keyring = () =>
  process.env.CLOUDFLARE_AUTH_USE_KEYRING === 'true' ||
  (process.env.CLOUDFLARE_AUTH_USE_KEYRING !== 'false' && state.keyringEnabled);
if (args[0] === 'auth' && args[1] === 'keyring' && args[2] === 'enable') {
  if (state.failKeyring) {
    finish(undefined, 1);
  }
  state.keyringEnabled = true;
  finish(undefined);
}
if (args[0] === 'whoami') {
  if (state.badWhoami) {
    save();
    process.stdout.write('invalid whoami output');
    process.exit(0);
  }
  if (
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.CF_API_TOKEN ||
    ((process.env.CLOUDFLARE_API_KEY || process.env.CF_API_KEY) &&
      (process.env.CLOUDFLARE_EMAIL || process.env.CF_EMAIL))
  ) {
    finish({ ...state.oldSession, authType: 'User API Token' });
  }
  if (keyring() && !state.encrypted && state.plaintext) {
    state.encrypted = state.plaintext;
    delete state.plaintext;
  }
  const session = keyring() ? state.encrypted : state.plaintext;
  finish(session ?? { loggedIn: false }, session ? 0 : 1);
}
if (args[0] === 'login') {
  if (state.failLogin) {
    finish(undefined, 1);
  }
  if (args.includes('--use-keyring')) {
    state.keyringEnabled = true;
  }
  if (keyring()) {
    state.encrypted = state.nextLogin;
    delete state.plaintext;
  } else {
    state.plaintext = state.nextLogin;
  }
  finish(undefined);
}
if (args[0] === 'logout') {
  delete state.encrypted;
  delete state.plaintext;
  finish(undefined);
}
finish(undefined, 2);
