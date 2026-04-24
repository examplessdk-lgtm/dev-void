import type { SubcommandDef } from './subcommand-prompt';

export const authSubcommands: Array<SubcommandDef> = [
  { name: 'login', description: 'Log in with GitHub or Google' },
  { name: 'logout', description: 'Log out and remove credentials' },
  { name: 'whoami', description: 'Show the logged-in username' },
  { name: 'token', description: 'Copy auth token to clipboard' },
];

export type AuthArgs = { subcommand: 'login' | 'logout' | 'whoami' | 'token' };

export function parseAuthArgs(args: Array<string>): AuthArgs {
  const [subcommand, extra] = args;
  if (!subcommand || !['login', 'logout', 'whoami', 'token'].includes(subcommand)) {
    throw new Error('auth: Usage: void auth <login|logout|whoami|token>.');
  }
  if (extra) {
    throw new Error(`auth: Unexpected argument '${extra}'.`);
  }
  return { subcommand: subcommand as AuthArgs['subcommand'] };
}
