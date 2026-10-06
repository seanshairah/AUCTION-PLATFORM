import 'reflect-metadata';
import { Module, type DynamicModule, type INestApplication, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { BiddingService } from '@abc/bidding';
import { RulebookStore, type Db } from '@abc/db';
import { RegistrationService } from '@abc/limits';
import { FakeGateway, PaynowGateway, PaymentService, type PaymentGateway } from '@abc/payments';
import { SellerService } from '@abc/seller';
import { SettlementService } from '@abc/settlement';
import { VehicleService } from '@abc/vehicles';
import { MoneyController } from './money/money.controller';
import { SellerController } from './seller/seller.controller';
import { ViewingsController } from './lots/viewings.controller';
import { ADMIN_CONTROLLERS, ADMIN_PROVIDERS } from './admin';
import { DevController } from './dev.controller';
import { AccountController } from './bidding/account.controller';
import { COMMS_CONTROLLERS, commsProviders } from './comms';
import { BidDesk } from './bidding/bid-desk';
import { jsonReplacer } from './http';
import { logisticsAndSupport } from './logistics/module';
import { CatalogueReader } from './lots/catalogue-reader';
import { AuctionsController, LotsController } from './lots/lots.controller';
import { readCookie, SESSION_COOKIE, verifySession, type RequestWithAccount } from './session';
import { SystemController } from './system.controller';
import { BID_DESK, CATALOGUE, CONFIG, DB, FAKE_GATEWAYS, PAYMENTS, RULEBOOK, SELLER, SETTLEMENT, VEHICLES, type ApiConfig } from './tokens';

/**
 * The API process: a NestJS modular monolith (ADR 004) over the domain packages.
 * Controllers are thin; every rule lives in the shared packages, so the API,
 * worker, web and admin can never disagree.
 */
function apiModule(db: Db, config: ApiConfig): DynamicModule {
  @Module({})
  class ApiModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer
        .apply((req: Request, _res: Response, next: NextFunction) => {
          (req as RequestWithAccount).account = verifySession(readCookie(req, SESSION_COOKIE), config.sessionSecret);
          next();
        })
        .forRoutes('*path');
    }
  }
  const rulebook = new RulebookStore(db);
  const registrations = new RegistrationService(rulebook);
  const bidding = new BiddingService(db, rulebook, registrations);
  const catalogue = new CatalogueReader(db, rulebook);
  const fakes = new Map<string, FakeGateway>();
  const gateways: PaymentGateway[] = [];
  if (config.fakeGateways) {
    for (const id of ['paynow', 'contipay']) fakes.set(id, new FakeGateway(id, `dev-${id}-secret`));
    gateways.push(...fakes.values());
  } else if (process.env.PAYNOW_USD_ID && process.env.PAYNOW_USD_KEY) {
    // Unverified against the Paynow sandbox (A32). One integration per currency, as Paynow issues them.
    gateways.push(new PaynowGateway({
      integrations: {
        USD: { id: process.env.PAYNOW_USD_ID, key: process.env.PAYNOW_USD_KEY },
        ...(process.env.PAYNOW_ZWG_ID && process.env.PAYNOW_ZWG_KEY ? { ZWG: { id: process.env.PAYNOW_ZWG_ID, key: process.env.PAYNOW_ZWG_KEY } } : {}),
      },
      resultUrl: process.env.PAYNOW_RESULT_URL ?? '',
      returnUrl: process.env.PAYNOW_RETURN_URL ?? '',
    }));
  }
  const logisticsSupport = logisticsAndSupport(db, rulebook, { ...process.env, GATE_PASS_SECRET: config.gatePassSecret });
  return {
    module: ApiModule,
    controllers: [LotsController, AuctionsController, AccountController, SystemController, MoneyController, SellerController, ViewingsController, ...logisticsSupport.controllers, ...ADMIN_CONTROLLERS, ...COMMS_CONTROLLERS, DevController],
    providers: [
      { provide: CONFIG, useValue: config },
      { provide: DB, useValue: db },
      { provide: RULEBOOK, useValue: rulebook },
      { provide: CATALOGUE, useValue: catalogue },
      { provide: BID_DESK, useValue: new BidDesk(db, rulebook, registrations, bidding, catalogue) },
      { provide: PAYMENTS, useValue: new PaymentService(db, rulebook, gateways) },
      { provide: FAKE_GATEWAYS, useValue: fakes },
      { provide: SETTLEMENT, useValue: new SettlementService(db, rulebook, { gatePassSecret: config.gatePassSecret }) },
      { provide: SELLER, useValue: new SellerService(db, rulebook) },
      { provide: VEHICLES, useValue: new VehicleService(db, rulebook) },
      ...logisticsSupport.providers,
      ...ADMIN_PROVIDERS,
      ...commsProviders(db, rulebook),
    ],
  };
}

export async function createApp(db: Db, config: ApiConfig): Promise<INestApplication> {
  // rawBody: provider webhooks are verified against the exact bytes received (docs/16).
  const app = await NestFactory.create(apiModule(db, config), { logger: ['error', 'warn'], rawBody: true });
  const express = app.getHttpAdapter().getInstance();
  express.set('json replacer', jsonReplacer);
  express.disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}
