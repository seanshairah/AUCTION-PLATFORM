import 'reflect-metadata';
import { Module, type DynamicModule, type INestApplication, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { BiddingService } from '@abc/bidding';
import { RulebookStore, type Db } from '@abc/db';
import { RegistrationService } from '@abc/limits';
import { AccountController } from './bidding/account.controller';
import { BidDesk } from './bidding/bid-desk';
import { jsonReplacer } from './http';
import { CatalogueReader } from './lots/catalogue-reader';
import { AuctionsController, LotsController } from './lots/lots.controller';
import { readCookie, SESSION_COOKIE, verifySession, type RequestWithAccount } from './session';
import { SystemController } from './system.controller';
import { BID_DESK, CATALOGUE, CONFIG, DB, RULEBOOK, type ApiConfig } from './tokens';

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
  return {
    module: ApiModule,
    controllers: [LotsController, AuctionsController, AccountController, SystemController],
    providers: [
      { provide: CONFIG, useValue: config },
      { provide: DB, useValue: db },
      { provide: RULEBOOK, useValue: rulebook },
      { provide: CATALOGUE, useValue: catalogue },
      { provide: BID_DESK, useValue: new BidDesk(db, rulebook, registrations, bidding, catalogue) },
    ],
  };
}

export async function createApp(db: Db, config: ApiConfig): Promise<INestApplication> {
  const app = await NestFactory.create(apiModule(db, config), { logger: ['error', 'warn'] });
  const express = app.getHttpAdapter().getInstance();
  express.set('json replacer', jsonReplacer);
  express.disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}
