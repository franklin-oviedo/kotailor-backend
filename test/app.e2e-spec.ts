import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { CONFIGURATION } from '../src/config.js';
import { SessionGuard } from '../src/auth/session.guard.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CONFIGURATION)
      .useValue({
        googleClientId: 'test-client',
        googleClientSecret: 'test-secret',
        googleRedirectUri: 'http://localhost:3000/api/auth/google/callback',
        databaseUrl: 'postgresql://localhost/kotailor_test',
      })
      .overrideGuard(SessionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('reports Calendar as unavailable when its optional configuration is absent', () => {
    return request(app.getHttpServer())
      .get('/workshops/00000000-0000-4000-8000-000000000000/calendar')
      .expect(503);
  });

  afterEach(async () => {
    await app.close();
  });
});
