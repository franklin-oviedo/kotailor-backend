import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CONFIGURATION, readConfiguration } from './config.js';
import { Database } from './database/database.js';
import { AuthController } from './auth/auth.controller.js';
import { GoogleIdentityProvider } from './auth/google-identity.js';
import { IdentityRepository } from './auth/identity.repository.js';
import { CustomersController } from './customers/customers.controller.js';
import { ClientPortalController } from './customers/client-portal.controller.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { OrdersController } from './orders/orders.controller.js';
import { WorkshopsController } from './workshops/workshops.controller.js';
import { CalendarConnectionController } from './calendar/calendar-connection.controller.js';
import { CalendarConnectionService } from './calendar/calendar-connection.service.js';
import { CalendarListService } from './calendar/calendar-list.service.js';
import { CalendarSelectionService } from './calendar/calendar-selection.service.js';
import { CalendarMoveService } from './calendar/calendar-move.service.js';
import { CalendarSyncQueueService } from './calendar/calendar-sync-queue.service.js';
import { CalendarSyncService } from './calendar/calendar-sync.service.js';
import { CalendarSyncWorker } from './calendar/calendar-sync-worker.js';
import { CalendarTokenCipher } from './calendar/calendar-token-cipher.js';
import { CALENDAR_EVENT_CLIENT, createCalendarEventClient, GoogleCalendarEvents } from './calendar/google-calendar-events.js';
import { CALENDAR_LIST_CLIENT, createCalendarListClient, GoogleCalendarList } from './calendar/google-calendar-list.js';
import { CALENDAR_OAUTH_CLIENT, createCalendarOAuthClient, GoogleCalendarOAuth } from './calendar/google-calendar-oauth.js';
import { CustomerAppointmentsController, WorkshopAppointmentsController } from './appointments/appointments.controller.js';
import { AppointmentsService } from './appointments/appointments.service.js';
import { PaymentsController, WorkshopPaymentsController } from './payments/payments.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { InvoicesController } from './invoices/invoices.controller.js';
import { InvoicesService } from './invoices/invoices.service.js';
import { ReportsController } from './reports/reports.controller.js';
import { ReportsService } from './reports/reports.service.js';

@Module({
  imports: [
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60000, limit: 120 }] }),
  ],
  controllers: [AppController, AuthController, CustomersController, ClientPortalController, CatalogController, OrdersController, WorkshopsController, CalendarConnectionController, WorkshopAppointmentsController, CustomerAppointmentsController, PaymentsController, WorkshopPaymentsController, InvoicesController, ReportsController],
  providers: [
    AppService,
    { provide: CONFIGURATION, useFactory: readConfiguration },
    Database,
    GoogleIdentityProvider,
    IdentityRepository,
    CalendarConnectionService,
    CalendarListService,
    CalendarSelectionService,
    CalendarMoveService,
    CalendarSyncService,
    CalendarSyncQueueService,
    CalendarSyncWorker,
    CalendarTokenCipher,
    GoogleCalendarOAuth,
    GoogleCalendarList,
    GoogleCalendarEvents,
    AppointmentsService,
    PaymentsService,
    InvoicesService,
    ReportsService,
    { provide: CALENDAR_OAUTH_CLIENT, useFactory: createCalendarOAuthClient, inject: [CONFIGURATION] },
    { provide: CALENDAR_LIST_CLIENT, useFactory: createCalendarListClient, inject: [CONFIGURATION] },
    { provide: CALENDAR_EVENT_CLIENT, useFactory: createCalendarEventClient, inject: [CONFIGURATION] },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
  exports: [Database, CONFIGURATION],
})
export class AppModule {}
