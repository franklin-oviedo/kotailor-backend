import {
  Body, Controller, ForbiddenException, Get, Header, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { CONFIGURATION, type Configuration } from '../config.js';
import { thermalTicketCsp } from '../documents/thermal-ticket.js';
import { PaymentsService } from './payments.service.js';

@Controller('workshops/:workshopId/orders/:orderId/payments')
@UseGuards(SessionGuard)
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(CONFIGURATION) private readonly config: Configuration,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string, @Query('includeCustomerBalance') includeCustomerBalance: unknown) {
    return this.payments.list(workshopId, request.session.userId!, orderId, includeCustomerBalance === 'true');
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string, @Body() body: unknown) {
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
    return this.payments.create(workshopId, request.session.userId!, orderId, body);
  }
}

@Controller('workshops/:workshopId/payments')
@UseGuards(SessionGuard)
export class WorkshopPaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(CONFIGURATION) private readonly config: Configuration,
  ) {}

  @Get(':paymentId/ticket')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', thermalTicketCsp)
  ticket(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string) {
    const url = new URL(`/api/workshops/${workshopId}/payments/${paymentId}/ticket`, this.config.frontendOrigin);
    return this.payments.ticket(workshopId, request.session.userId!, paymentId, url.href);
  }

  @Get('order-receivables')
  @Header('Cache-Control', 'no-store')
  listOrderReceivables(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string) {
    return this.payments.listOrderReceivables(workshopId, request.session.userId!);
  }

  @Get('manual-receivables')
  @Header('Cache-Control', 'no-store')
  listManualReceivables(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string) {
    return this.payments.listManualReceivables(workshopId, request.session.userId!);
  }

  @Get('dashboard')
  @Header('Cache-Control', 'no-store')
  dashboard(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Query('page') page: unknown, @Query('pageSize') pageSize: unknown,
    @Query('month') month: unknown, @Query('method') method: unknown, @Query('search') search: unknown) {
    return this.payments.dashboard(workshopId, request.session.userId!, { page, pageSize, month, method, search });
  }
}
