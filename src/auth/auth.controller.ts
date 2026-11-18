import { timingSafeEqual } from 'node:crypto';
import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Session } from 'express-session';
import { Throttle } from '@nestjs/throttler';
import { CONFIGURATION, type Configuration } from '../config.js';
import { GoogleIdentityProvider } from './google-identity.js';
import { IdentityRepository } from './identity.repository.js';
import { SessionGuard } from './session.guard.js';
import {
  AuthenticationError,
  AuthDestination,
  SESSION_COOKIE,
  SESSION_DURATION_MS,
} from './auth.types.js';

function save(session: Session): Promise<void> {
  return new Promise((resolve, reject) => session.save((error) => error ? reject(error) : resolve()));
}

function regenerate(session: Session): Promise<void> {
  return new Promise((resolve, reject) => session.regenerate((error) => error ? reject(error) : resolve()));
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(CONFIGURATION) private readonly config: Configuration,
    @Inject(GoogleIdentityProvider) private readonly google: GoogleIdentityProvider,
    @Inject(IdentityRepository) private readonly identities: IdentityRepository,
  ) {}

  @Get('google')
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  async start(@Req() request: Request, @Res() response: Response): Promise<void> {
    await this.startFlow(request, response, AuthDestination.Workshop);
  }

  @Get('google/client')
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  async startClient(@Req() request: Request, @Res() response: Response): Promise<void> {
    await this.startFlow(request, response, AuthDestination.ClientPortal);
  }

  private async startFlow(request: Request, response: Response, destination: AuthDestination): Promise<void> {
    const pendingInvitation = request.session.pendingInvitation;
    await regenerate(request.session);
    request.session.pendingInvitation = pendingInvitation;
    request.session.authDestination = destination;
    const { flow, url } = this.google.begin();
    request.session.oauth = flow;
    request.session.cookie.maxAge = flow.expiresAt - Date.now();
    await save(request.session);
    response.redirect(url);
  }

  @Get('google/callback')
  async callback(@Req() request: Request, @Res() response: Response): Promise<void> {
    const flow = request.session.oauth;
    const destination = request.session.authDestination;
    const { state, code, error } = request.query;
    delete request.session.oauth;
    delete request.session.authDestination;
    await save(request.session);

    if (
      !flow ||
      flow.expiresAt <= Date.now() ||
      typeof state !== 'string' ||
      Buffer.byteLength(state) !== Buffer.byteLength(flow.state) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))
    ) {
      this.logger.warn('OAuth callback rejected: missing, expired or mismatched state');
      this.failure(response, AuthenticationError.InvalidFlow, destination);
      return;
    }
    if (error === 'access_denied') {
      this.failure(response, AuthenticationError.Cancelled, destination);
      return;
    }
    if (error || typeof code !== 'string' || !code) {
      this.failure(response, AuthenticationError.InvalidFlow, destination);
      return;
    }

    let identity;
    try {
      identity = await this.google.verify(code, flow);
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
      this.failure(response, AuthenticationError.GoogleUnavailable, destination);
      return;
    }
    const user = await this.identities.signIn(identity);
    const pendingInvitation = request.session.pendingInvitation;
    await regenerate(request.session);
    request.session.pendingInvitation = pendingInvitation;
    request.session.userId = user.id;
    request.session.authenticatedUntil = Date.now() + SESSION_DURATION_MS;
    request.session.cookie.maxAge = SESSION_DURATION_MS;
    await save(request.session);
    const path = pendingInvitation ? 'invitacion' : destination === AuthDestination.ClientPortal ? 'portal/inicio' : 'inicio';
    response.redirect(`${this.config.frontendOrigin}/${path}`);
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionGuard)
  async me(@Req() request: Request) {
    const userId = request.session.userId!;
    const user = await this.identities.findUser(userId);
    if (!user) throw new UnauthorizedException('User no longer exists');
    return { user, workshops: await this.identities.memberships(userId),
      platformAdministrator: await this.identities.isPlatformAdministrator(userId),
      canCreateWorkshop: await this.identities.canCreateWorkshop(userId) };
  }

  @Post('logout')
  async logout(@Req() request: Request, @Res() response: Response): Promise<void> {
    if (request.get('origin') !== this.config.frontendOrigin) {
      throw new ForbiddenException('Invalid request origin');
    }
    await new Promise<void>((resolve, reject) =>
      request.session.destroy((error) => error ? reject(error) : resolve()),
    );
    response.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: this.config.production,
      sameSite: 'lax',
      path: '/',
    });
    response.status(204).end();
  }

  private failure(response: Response, reason: AuthenticationError, destination?: AuthDestination): void {
    const path = destination === AuthDestination.ClientPortal ? '/portal' : '/';
    response.redirect(`${this.config.frontendOrigin}${path}?authError=${reason}`);
  }
}
