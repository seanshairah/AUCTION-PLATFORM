import type { Provider } from '@nestjs/common';
import { BiddingService } from '@abc/bidding';
import { createAdminServices } from '@abc/admin';
import { Analytics } from '@abc/analytics';
import type { Db, RulebookStore } from '@abc/db';
import { RegistrationService } from '@abc/limits';
import { AnalyticsController } from '../analytics/analytics.controller';
import { DB, RULEBOOK } from '../tokens';
import { AuctionsController } from './auctions.controller';
import { BuyerDefaultsController, DefaultsController } from './defaults.controller';
import { OverridesController } from './overrides.controller';
import { ReconciliationController } from './reconciliation.controller';
import { RiskController } from './risk.controller';
import { RulebookController } from './rulebook.controller';
import { StaffSessionController } from './staff-session.controller';
import { StaffGuard } from './staff.guard';
import { ADMIN, ANALYTICS } from './tokens';

/** The staff console's controllers, appended to the API module in app.ts. */
export const ADMIN_CONTROLLERS = [
  StaffSessionController,
  OverridesController,
  RulebookController,
  RiskController,
  ReconciliationController,
  DefaultsController,
  BuyerDefaultsController,
  AuctionsController,
  AnalyticsController,
];

/** Its providers, built from the API's DB and RULEBOOK. Analytics reads the same connection until a replica is configured. */
export const ADMIN_PROVIDERS: Provider[] = [
  StaffGuard,
  {
    provide: ADMIN,
    inject: [DB, RULEBOOK],
    useFactory: (db: Db, rulebook: RulebookStore) => {
      const registrations = new RegistrationService(rulebook);
      return createAdminServices(db, rulebook, { registrations, bidding: new BiddingService(db, rulebook, registrations) });
    },
  },
  { provide: ANALYTICS, inject: [DB], useFactory: (db: Db) => new Analytics(db) },
];
