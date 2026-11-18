import {
  Body, Controller, ForbiddenException, Get, Header, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { CONFIGURATION, type Configuration } from '../config.js';
import { AppointmentActor } from './appointments.schema.js';
import { AppointmentsService } from './appointments.service.js';

@Controller('workshops/:workshopId/appointments')
@UseGuards(SessionGuard)
export class WorkshopAppointmentsController {
  constructor(
    @Inject(AppointmentsService) private readonly appointments: AppointmentsService,
    @Inject(CONFIGURATION) private readonly config: Configuration,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Query('from') from: unknown, @Query('to') to: unknown) {
    return this.appointments.list(workshopId, request.session.userId!, AppointmentActor.Workshop, from, to);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string, @Body() body: unknown) {
    this.requireOrigin(request);
    return this.appointments.create(workshopId, request.session.userId!, AppointmentActor.Workshop, body);
  }

  @Put(':id')
  @Header('Cache-Control', 'no-store')
  reschedule(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    this.requireOrigin(request);
    return this.appointments.reschedule(workshopId, request.session.userId!, AppointmentActor.Workshop, id, body);
  }

  @Post(':id/cancel')
  @Header('Cache-Control', 'no-store')
  cancel(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    this.requireOrigin(request);
    return this.appointments.cancel(workshopId, request.session.userId!, AppointmentActor.Workshop, id, body);
  }

  private requireOrigin(request: Request): void {
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
  }
}

@Controller('client/workshops/:workshopId/appointments')
@UseGuards(SessionGuard)
export class CustomerAppointmentsController {
  constructor(
    @Inject(AppointmentsService) private readonly appointments: AppointmentsService,
    @Inject(CONFIGURATION) private readonly config: Configuration,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Query('from') from: unknown, @Query('to') to: unknown,
    @Query('page') page: unknown, @Query('pageSize') pageSize: unknown) {
    return this.appointments.list(workshopId, request.session.userId!, AppointmentActor.Customer, from, to, page, pageSize);
  }

  @Get('options')
  @Header('Cache-Control', 'no-store')
  options(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string) {
    return this.appointments.customerOptions(workshopId, request.session.userId!);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string, @Body() body: unknown) {
    this.requireOrigin(request);
    return this.appointments.create(workshopId, request.session.userId!, AppointmentActor.Customer, body);
  }

  @Put(':id')
  @Header('Cache-Control', 'no-store')
  reschedule(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    this.requireOrigin(request);
    return this.appointments.reschedule(workshopId, request.session.userId!, AppointmentActor.Customer, id, body);
  }

  @Post(':id/cancel')
  @Header('Cache-Control', 'no-store')
  cancel(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    this.requireOrigin(request);
    return this.appointments.cancel(workshopId, request.session.userId!, AppointmentActor.Customer, id, body);
  }

  private requireOrigin(request: Request): void {
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
  }
}
