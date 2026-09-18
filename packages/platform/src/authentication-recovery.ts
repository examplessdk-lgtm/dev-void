/** Owner recovery capabilities authorize a provider test, never a platform session. */
export type PlatformAuthenticationRecovery = Readonly<{
  installationId: string;
  administratorUserId: string;
  connectionId: string;
  revision: number;
  generation: number;
  testId: string;
  expiresAt: string;
  signature: string;
}>;

export function platformAuthenticationRecoveryMessage(
  value: Omit<PlatformAuthenticationRecovery, 'signature'>,
): string {
  return JSON.stringify([
    'void-platform-auth-recovery-v1',
    value.installationId,
    value.administratorUserId,
    value.connectionId,
    value.revision,
    value.generation,
    value.testId,
    value.expiresAt,
  ]);
}
