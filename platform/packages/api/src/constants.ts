export const SITE_DOMAIN = 'void.app';
export const DEFAULT_DASHBOARD_URL = 'https://dash.void.cloud';
export const DEFAULT_DISPATCH_NAMESPACE = 'void-users';
export const MAX_SECRET_NAME_LENGTH = 256;
export const MAX_SECRET_VALUE_BYTES = 128 * 1024; // 128 KB

// TTL for a cached org-membership row in `github_installation_members`. The
// org-shared GitHub App flow re-verifies repo access per-connect; this cache
// only short-circuits the org-membership check while it is fresh (~24h). Single
// source of truth for the membership TTL.
export const MEMBERSHIP_TTL_SECONDS = 60 * 60 * 24; // 24h
