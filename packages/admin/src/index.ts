import type { BiddingService } from '@abc/bidding';
import type { Db, RulebookStore } from '@abc/db';
import type { RegistrationService } from '@abc/limits';
import { AuctionScheduler } from './auctions';
import { DefaultAppeals, defaultWaiverHandler } from './defaults';
import { OverrideService } from './overrides';
import { ReconciliationQueue, reconciliationWriteOffHandler } from './reconciliation';
import { limitChangeHandler, RiskConsole, tierChangeHandler } from './risk';
import { RuleSetPublication, taxRateActivationHandler } from './rulebook';

export * from './permissions';
export * from './overrides';
export * from './rulebook';
export * from './risk';
export * from './reconciliation';
export * from './defaults';
export * from './auctions';
export * from './dashboard';

/** Everything the operations console uses, wired once (docs/18 §2). */
export interface AdminServices {
  overrides: OverrideService;
  rulebook: RuleSetPublication;
  risk: RiskConsole;
  reconciliation: ReconciliationQueue;
  defaults: DefaultAppeals;
  auctions: AuctionScheduler;
}

export function createAdminServices(db: Db, rulebook: RulebookStore, deps: { registrations: RegistrationService; bidding: BiddingService }): AdminServices {
  const overrides = new OverrideService(db, rulebook);
  overrides.register(limitChangeHandler);
  overrides.register(tierChangeHandler(rulebook));
  overrides.register(taxRateActivationHandler);
  overrides.register(defaultWaiverHandler(rulebook));
  overrides.register(reconciliationWriteOffHandler);
  return {
    overrides,
    rulebook: new RuleSetPublication(db),
    risk: new RiskConsole(db, rulebook, deps.registrations),
    reconciliation: new ReconciliationQueue(db, rulebook),
    defaults: new DefaultAppeals(db),
    auctions: new AuctionScheduler(db, rulebook, deps.bidding),
  };
}
