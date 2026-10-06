import type { Provider, Type } from '@nestjs/common';
import type { Db, RulebookStore } from '@abc/db';
import { LogisticsService } from '@abc/logistics';
import { SettlementService } from '@abc/settlement';
import { SupportService } from '@abc/support';
import { VehicleService } from '@abc/vehicles';
import { StaffGuard } from '../staff-guard';
import { SupportController, SupportStaffController } from '../support/support.controller';
import { LogisticsController, LogisticsStaffController } from './logistics.controller';
import { gatePassSecretFromEnv, LOGISTICS, SUPPORT } from './tokens';

/** Controllers and providers for deliverables 15 (logistics) and 17 (support and disputes), appended in app.ts. */
export function logisticsAndSupport(db: Db, rulebook: RulebookStore, env: NodeJS.ProcessEnv = process.env): { controllers: Type<unknown>[]; providers: Provider[] } {
  const settlement = new SettlementService(db, rulebook, { gatePassSecret: gatePassSecretFromEnv(env) });
  return {
    controllers: [LogisticsController, LogisticsStaffController, SupportController, SupportStaffController],
    providers: [
      StaffGuard,
      { provide: LOGISTICS, useValue: new LogisticsService(db, rulebook, settlement) },
      { provide: SUPPORT, useValue: new SupportService(db, rulebook, new VehicleService(db, rulebook)) },
    ],
  };
}
