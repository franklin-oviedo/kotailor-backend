import { Controller, Get, Header, Inject, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { ReportsService } from './reports.service.js';

@Controller('workshops/:workshopId/reports')
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @Get('executive')
  @Header('Cache-Control', 'no-store')
  executive(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Query() query: unknown,
  ) {
    return this.reports.executive(workshopId, request.session.userId!, query);
  }
}
