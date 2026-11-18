import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import session from 'express-session';
import request from 'supertest';
import { AuthController } from '../src/auth/auth.controller.js';
import { GoogleIdentityProvider } from '../src/auth/google-identity.js';
import { IdentityRepository } from '../src/auth/identity.repository.js';
import { CONFIGURATION, readConfiguration } from '../src/config.js';
import type { OAuthFlow } from '../src/auth/auth.types.js';

describe('Google authentication HTTP flow', () => {
  let app: NestExpressApplication;
  const config = readConfiguration({
    NODE_ENV: 'test',
    PORT: '3000',
    FRONTEND_ORIGIN: 'http://localhost:4200',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google/callback',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-only-session-secret-with-at-least-32-characters',
    DATABASE_URL: 'postgresql://localhost/kotailor_test',
  });
  let flow: OAuthFlow;
  const user = { id: 'test-user', email: 'test@example.invalid', name: 'Test' };
  const google = { begin: vi.fn(), verify: vi.fn() };
  const identities = {
    signIn: vi.fn(),
    findUser: vi.fn(),
    memberships: vi.fn(),
    isPlatformAdministrator: vi.fn(),
    canCreateWorkshop: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    flow = {
      state: 'test-state',
      nonce: 'test-nonce',
      verifier: 'test-verifier',
      expiresAt: Date.now() + 60000,
    };
    google.begin.mockReturnValue({ flow, url: 'https://accounts.google.com/test' });
    google.verify.mockResolvedValue({
      subject: 'google-subject', email: user.email, name: user.name,
    });
    identities.signIn.mockResolvedValue(user);
    identities.findUser.mockResolvedValue(user);
    identities.memberships.mockResolvedValue([]);
    identities.isPlatformAdministrator.mockResolvedValue(false);
    identities.canCreateWorkshop.mockResolvedValue(false);

    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: CONFIGURATION, useValue: config },
        { provide: GoogleIdentityProvider, useValue: google },
        { provide: IdentityRepository, useValue: identities },
      ],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api');
    app.use(session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax' },
    }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects callbacks with no browser session or with a mismatched state', async () => {
    await request(app.getHttpServer())
      .get('/api/auth/google/callback?state=test-state&code=test-code')
      .expect(302)
      .expect('Location', `${config.frontendOrigin}/?authError=invalid_flow`);
    const browser = request.agent(app.getHttpServer());
    await browser.get('/api/auth/google').expect(302);
    await browser.get('/api/auth/google/callback?state=wrong&code=test-code')
      .expect(302)
      .expect('Location', `${config.frontendOrigin}/?authError=invalid_flow`);
    expect(google.verify).not.toHaveBeenCalled();
  });

  it('rejects expired state and reports cancellation without creating a user', async () => {
    flow.expiresAt = Date.now() + 1000;
    const browser = request.agent(app.getHttpServer());
    await browser.get('/api/auth/google').expect(302);
    flow.expiresAt = Date.now() - 1;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await browser.get('/api/auth/google/callback?state=test-state&code=test-code')
      .expect(302)
      .expect('Location', `${config.frontendOrigin}/?authError=invalid_flow`);
    flow.expiresAt = Date.now() + 60000;
    await browser.get('/api/auth/google').expect(302);
    await browser.get('/api/auth/google/callback?state=test-state&error=access_denied')
      .expect(302)
      .expect('Location', `${config.frontendOrigin}/?authError=cancelled`);
    expect(identities.signIn).not.toHaveBeenCalled();
  });

  it('rotates the session, returns the persisted identity and rejects callback reuse', async () => {
    const browser = request.agent(app.getHttpServer());
    await browser.get('/api/auth/me').expect(401);
    const start = await browser.get('/api/auth/google').expect(302);
    const callback = await browser.get('/api/auth/google/callback?state=test-state&code=test-code')
      .expect(302)
      .expect('Location', `${config.frontendOrigin}/inicio`);
    expect(callback.headers['set-cookie']).not.toEqual(start.headers['set-cookie']);
    await browser.get('/api/auth/me').expect(200).expect({ user, workshops: [], platformAdministrator: false, canCreateWorkshop: false });
    await browser.get('/api/auth/google/callback?state=test-state&code=test-code')
      .expect(302)
      .expect('Location', `${config.frontendOrigin}/?authError=invalid_flow`);
    expect(google.verify).toHaveBeenCalledOnce();
    expect(identities.signIn).toHaveBeenCalledOnce();
  });

  it('does not create a session when Google validation fails', async () => {
    google.verify.mockRejectedValue(new UnauthorizedException());
    const browser = request.agent(app.getHttpServer());
    await browser.get('/api/auth/google').expect(302);
    await browser.get('/api/auth/google/callback?state=test-state&code=test-code')
      .expect(302)
      .expect('Location', `${config.frontendOrigin}/?authError=google_unavailable`);
    await browser.get('/api/auth/me').expect(401);
    expect(identities.signIn).not.toHaveBeenCalled();
  });

  it('returns client portal sign-ins and errors to the client portal', async () => {
    const browser = request.agent(app.getHttpServer());
    await browser.get('/api/auth/google/client').expect(302);
    await browser.get('/api/auth/google/callback?state=test-state&error=access_denied')
      .expect(302).expect('Location', `${config.frontendOrigin}/portal?authError=cancelled`);
    await browser.get('/api/auth/google/client').expect(302);
    await browser.get('/api/auth/google/callback?state=test-state&code=test-code')
      .expect(302).expect('Location', `${config.frontendOrigin}/portal/inicio`);
    await browser.get('/api/auth/me').expect(200);
  });

  it('requires a trusted origin for logout and destroys the authenticated session', async () => {
    const browser = request.agent(app.getHttpServer());
    await browser.get('/api/auth/google').expect(302);
    await browser.get('/api/auth/google/callback?state=test-state&code=test-code').expect(302);
    await browser.post('/api/auth/logout').set('Origin', 'https://attacker.invalid').expect(403);
    await browser.get('/api/auth/me').expect(200);
    await browser.post('/api/auth/logout').set('Origin', config.frontendOrigin).expect(204);
    await browser.get('/api/auth/me').expect(401);
  });
});
