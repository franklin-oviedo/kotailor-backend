import { createHash, randomBytes } from 'node:crypto';
import { OAUTH_DURATION_MS, type OAuthFlow } from './auth.types.js';

export function createOAuthFlow(): OAuthFlow {
  return {
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    verifier: randomBytes(32).toString('base64url'),
    expiresAt: Date.now() + OAUTH_DURATION_MS,
  };
}

export function oauthChallenge(flow: OAuthFlow): string {
  return createHash('sha256').update(flow.verifier).digest('base64url');
}
