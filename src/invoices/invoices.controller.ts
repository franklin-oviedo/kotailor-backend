import {
  Body, Controller, ForbiddenException, Get, Header, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, StreamableFile, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { CONFIGURATION, type Configuration } from '../config.js';
import { thermalTicketCsp } from '../documents/thermal-ticket.js';
import { PaymentsService } from '../payments/payments.service.js';
import { InvoicesService } from './invoices.service.js';

@Controller('workshops/:workshopId')
@UseGuards(SessionGuard)
export class InvoicesController {
  constructor(
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(CONFIGURATION) private readonly config: Configuration,
  ) {}

  @Get('billing-profile')
  @Header('Cache-Control', 'no-store')
  billingProfile(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string) {
    return this.invoices.billingProfile(workshopId, request.session.userId!);
  }

  @Put('billing-profile')
  @Header('Cache-Control', 'no-store')
  updateBillingProfile(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string, @Body() body: unknown,
  ) {
    this.requireSameOrigin(request);
    return this.invoices.updateBillingProfile(workshopId, request.session.userId!, body);
  }

  @Get('invoices')
  @Header('Cache-Control', 'no-store')
  list(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Query('search') search: unknown, @Query('page') page: unknown, @Query('pageSize') pageSize: unknown,
    @Query('status') status: unknown,
  ) {
    return this.invoices.list(workshopId, request.session.userId!, search, page, pageSize, status);
  }

  @Put('invoice-tax-settings')
  @Header('Cache-Control', 'no-store')
  updateTaxSettings(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string, @Body() body: unknown) {
    this.requireSameOrigin(request);
    return this.invoices.updateTaxSettings(workshopId, request.session.userId!, body);
  }

  @Post('orders/apply-pending-itbis')
  @Header('Cache-Control', 'no-store')
  applyPendingOrderTax(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string, @Body() body: unknown) {
    this.requireSameOrigin(request);
    return this.invoices.applyPendingOrderTax(workshopId, request.session.userId!, body);
  }

  @Post('invoices')
  @Header('Cache-Control', 'no-store')
  create(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string, @Body() body: unknown,
  ) {
    this.requireSameOrigin(request);
    return this.invoices.create(workshopId, request.session.userId!, body);
  }

  @Get('invoices/:invoiceId')
  @Header('Cache-Control', 'no-store')
  detail(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Query('page') page: unknown, @Query('pageSize') pageSize: unknown,
  ) {
    return this.invoices.detail(workshopId, request.session.userId!, invoiceId, page, pageSize);
  }

  @Get('invoices/:invoiceId/pdf')
  @Header('Cache-Control', 'no-store')
  async pdf(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Query('preview') preview: unknown,
  ) {
    const pdf = await this.invoices.pdf(workshopId, request.session.userId!, invoiceId);
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `${preview === 'true' ? 'inline' : 'attachment'}; filename="factura-${invoiceId}.pdf"`,
    });
  }

  @Get('invoices/:invoiceId/ticket')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', thermalTicketCsp)
  ticket(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ) {
    const url = new URL(`/api/workshops/${workshopId}/invoices/${invoiceId}/ticket`, this.config.frontendOrigin);
    return this.invoices.thermalTicket(workshopId, request.session.userId!, invoiceId, url.href);
  }

  @Put('invoices/:invoiceId')
  @Header('Cache-Control', 'no-store')
  update(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string, @Body() body: unknown,
  ) {
    this.requireSameOrigin(request);
    return this.invoices.update(workshopId, request.session.userId!, invoiceId, body);
  }

  @Post('invoices/:invoiceId/issue')
  @Header('Cache-Control', 'no-store')
  issue(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string, @Body() body: unknown,
  ) {
    this.requireSameOrigin(request);
    return this.invoices.issue(workshopId, request.session.userId!, invoiceId, body);
  }

  @Post('invoices/:invoiceId/void')
  @Header('Cache-Control', 'no-store')
  void(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string, @Body() body: unknown,
  ) {
    this.requireSameOrigin(request);
    return this.invoices.void(workshopId, request.session.userId!, invoiceId, body);
  }

  @Get('invoices/:invoiceId/payments')
  @Header('Cache-Control', 'no-store')
  listPayments(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string, @Query('includeCustomerBalance') includeCustomerBalance: unknown,
  ) {
    return this.payments.listInvoice(workshopId, request.session.userId!, invoiceId, includeCustomerBalance === 'true');
  }

  @Post('invoices/:invoiceId/payments')
  @Header('Cache-Control', 'no-store')
  createPayment(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string, @Body() body: unknown,
  ) {
    this.requireSameOrigin(request);
    return this.payments.createInvoice(workshopId, request.session.userId!, invoiceId, body);
  }

  private requireSameOrigin(request: Request) {
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
  }
}
