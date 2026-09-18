/** Identity data shared by storage and authentication without importing a protocol client. */
export type PlatformOidcIdentity = Readonly<{
  issuer: string;
  subject: string;
  login: string;
  email: string | null;
  emailVerified: boolean;
  groups: ReadonlyArray<string>;
}>;

export type CompanyIdentity = Readonly<{ issuer: string; subject: string }>;
