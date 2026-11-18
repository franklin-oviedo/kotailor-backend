import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (
      !request.session.userId ||
      !request.session.authenticatedUntil ||
      request.session.authenticatedUntil <= Date.now()
    ) {
      throw new UnauthorizedException('Sign in with Google to continue');
    }
    return true;
  }
}
