import type { DeployArtifact } from '@void/deploy-core';
import type { CompanyIdentity } from './identity-types.ts';
import type { JwtPayload } from './jwt.ts';

export type OAuthScope = 'profile' | 'deploy:approve';
export type OAuthRequestData = {
  kind: 'profile' | 'deployment' | 'connections';
  redirectUri: string;
  state: string;
  challenge: string;
  loginVerifier?: string;
  grantId?: string;
  slug?: string;
  checkpoint?: string;
  artifact?: DeployArtifact;
  artifactDigest?: string;
  workerModules?: Array<string>;
  projectId?: string;
};
export type OAuthSession = Pick<JwtPayload, 'sub' | 'aud' | 'sid' | 'exp'> & {
  // Attested by Void's Access middleware during consent, never by the client.
  companyIdentity?: CompanyIdentity;
};
