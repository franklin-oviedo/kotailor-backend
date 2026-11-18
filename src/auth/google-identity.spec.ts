import { createHash } from 'node:crypto';
import { readConfiguration } from '../config.js';
import { GoogleIdentityProvider } from './google-identity.js';

describe('GoogleIdentityProvider', () => {
  it('requests identity only and binds the transaction to state, nonce and PKCE', () => {
    const provider = new GoogleIdentityProvider(readConfiguration({
      NODE_ENV: 'test',
      PORT: '3000',
      FRONTEND_ORIGIN: 'http://localhost:4200',
      GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google/callback',
      GOOGLE_CLIENT_ID: 'test-client',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      SESSION_SECRET: 'test-only-session-secret-with-at-least-32-characters',
      DATABASE_URL: 'postgresql://localhost/kotailor_test',
    }));
    const { flow, url } = provider.begin();
    const parameters = new URL(url).searchParams;

    expect(parameters.get('scope')?.split(' ')).toEqual(['openid', 'email', 'profile']);
    expect(parameters.get('state')).toBe(flow.state);
    expect(parameters.get('nonce')).toBe(flow.nonce);
    expect(parameters.get('code_challenge_method')).toBe('S256');
    expect(parameters.get('code_challenge')).toBe(
      createHash('sha256').update(flow.verifier).digest('base64url'),
    );
    expect(provider.begin().flow.state).not.toBe(flow.state);
    expect(url).not.toContain('test-client-secret');
  });
});
