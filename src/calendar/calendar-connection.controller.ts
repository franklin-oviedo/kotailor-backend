import {
  Body, Controller, ForbiddenException, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, ServiceUnavailableException, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { CONFIGURATION, type Configuration } from '../config.js';
import { CalendarConnectionService } from './calendar-connection.service.js';
import { CalendarListService } from './calendar-list.service.js';
import { CalendarSelectionService } from './calendar-selection.service.js';

@Controller()
@UseGuards(SessionGuard)
export class CalendarConnectionController {
  constructor(
    @Inject(CalendarConnectionService) private readonly connections: CalendarConnectionService,
    @Inject(CalendarListService) private readonly calendars: CalendarListService,
    @Inject(CalendarSelectionService) private readonly selection: CalendarSelectionService,
    @Inject(CONFIGURATION) private readonly config: Configuration,
  ) {}

  @Post('workshops/:workshopId/calendar/authorization')
  @Header('Cache-Control', 'no-store')
  start(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string) {
    this.requireConfigured();
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
    return this.connections.begin(workshopId, request.session.userId!, request.sessionID);
  }

  @Get('workshops/:workshopId/calendar')
  @Header('Cache-Control', 'no-store')
  status(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string) {
    this.requireConfigured();
    return this.connections.status(workshopId, request.session.userId!);
  }

  @Get('workshops/:workshopId/calendar/calendars')
  @Header('Cache-Control', 'no-store')
  list(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string, @Query('pageToken') pageToken: unknown) {
    this.requireConfigured();
    return this.calendars.list(workshopId, request.session.userId!, pageToken);
  }

  @Get('workshops/:workshopId/calendar/selection')
  @Header('Cache-Control', 'no-store')
  selectionStatus(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string) {
    this.requireConfigured();
    return this.selection.status(workshopId, request.session.userId!);
  }

  @Post('workshops/:workshopId/calendar/selection')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  select(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string, @Body() body: unknown) {
    this.requireConfigured();
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
    return this.selection.selectInitial(workshopId, request.session.userId!, body);
  }

  @Get('workshops/:workshopId/calendar/move')
  @Header('Cache-Control', 'no-store')
  moveStatus(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string) {
    this.requireConfigured();
    return this.selection.moveStatus(workshopId, request.session.userId!);
  }

  @Post('workshops/:workshopId/calendar/disconnect')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async disconnect(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string): Promise<void> {
    this.requireConfigured();
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
    await this.connections.disconnect(workshopId, request.session.userId!);
  }

  @Get('calendar/google/callback')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async callback(
    @Req() request: Request, @Res() response: Response,
    @Query('state') state: unknown, @Query('code') code: unknown, @Query('error') error: unknown,
  ): Promise<void> {
    this.requireConfigured();
    if (error !== undefined) {
      if (typeof error !== 'string' || !error || code !== undefined) throw new UnauthorizedException('Invalid calendar authorization');
      await this.connections.cancel(request.session.userId!, request.sessionID, state);
      const result = error === 'access_denied' ? 'cancelled' : 'error';
      response.redirect(`${this.config.frontendOrigin}/agenda/calendar?calendar=${result}`);
      return;
    }
    await this.connections.complete(request.session.userId!, request.sessionID, state, code);
    response.redirect(`${this.config.frontendOrigin}/agenda/calendar?calendar=connected`);
  }

  private requireConfigured(): void {
    if (!this.config.calendar) throw new ServiceUnavailableException('Google Calendar is not configured');
  }
}
