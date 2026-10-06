/** Shapes returned by the API (apps/api). Money is always minor units as a string plus display text. */
export interface Money {
  minor: string;
  currency: 'USD' | 'ZWG';
  text: string;
}

export interface VehicleSpec {
  make: string;
  model: string;
  year: number | null;
  odometerKm: number | null;
  transmission: string | null;
  fuel: string | null;
  bodyStyle: string | null;
  drive: string | null;
  colour: string | null;
  zimbabweRegistered: boolean;
}

export interface LotCard {
  id: string;
  ref: string;
  title: string;
  category: { code: string; name: string };
  isVehicle: boolean;
  vehicle: VehicleSpec | null;
  branch: { code: string; name: string };
  auction: { id: string; code: string; title: string; depositRequired: boolean };
  currency: 'USD' | 'ZWG';
  startingBid: Money;
  currentPrice: Money | null;
  nextMinimum: Money;
  allInAtNextMinimum: Money | null;
  bids: number;
  bidders: number;
  endsAt: string;
  extended: boolean;
  reserveStatus: 'no_reserve' | 'met' | 'not_met';
  inspectionSummary: string | null;
  photoCount: number;
  cover: string | null;
  viewer: { leading: boolean } | null;
}

export interface InspectionItem {
  id: string;
  label: string;
  material: boolean;
  answer: 'ok' | 'attention' | 'fail' | 'not_applicable' | 'missing';
  note: string | null;
}

export interface LotDetail extends Omit<LotCard, 'viewer'> {
  description: string;
  itemState: { code: string; label: string };
  condition: { code: string; label: string; notes: string | null };
  documentsStatus: string | null;
  scheduledEndAt: string;
  closed: boolean;
  result: string;
  media: Array<{ kind: string; role: string; url: string }>;
  inspection: {
    publishedAt: string;
    inspectedAt: string;
    checklistVersion: string;
    summary: string;
    odometerKm: number | null;
    photoCount: number;
    hasVideo: boolean;
    identityVerified: boolean;
    sections: Array<{ section: string; items: InspectionItem[] }>;
  } | null;
  history: Array<{ seq: string; bidder: string; amount: Money; auto: boolean; at: string }>;
  breakdown: { atHammer: Money; lines: Array<{ type: string; description: string; amount: Money }>; total: Money; ruleVersionId: string } | null;
  rules: {
    versionLabel: string;
    softCloseSeconds: number;
    claimWindowHours: number | null;
    payWindowHours: number | null;
    collectWindowHours: number | null;
    depositMinimum: Money | null;
  } | null;
  towingPartners: Array<{ name: string; phone: string; notes: string | null }>;
  jsonLd: Record<string, unknown>;
  viewer: { leading: boolean; yourMax: Money | null; registration: string | null } | null;
}

export type Facets = Record<string, Array<{ value: string; count: number }>>;

export interface Me {
  id: string;
  name: string;
  verification: string;
  tier: string;
  email: string | null;
  phone: string | null;
}

export interface Wallet {
  balances: Array<{ currency: string; available: Money; held: Money }>;
  holds: Array<{ id: string; description: string; amount: Money; since: string }>;
  payments: Array<{ id: string; method: string; status: string; amount: Money; at: string; receipt: string | null }>;
}

export interface MyBid {
  id: string;
  ref: string;
  title: string;
  status: 'leading' | 'outbid' | 'won' | 'lost';
  currentPrice: Money | null;
  yourMax: Money | null;
  endsAt: string;
  lastBidAt: string;
}

export interface Preview {
  status: 'empty' | 'invalid' | 'below_minimum' | 'unavailable' | 'over_limit' | 'ok';
  message: string;
  registered: boolean;
  availableToBid: Money | null;
  amount?: Money;
  lines?: Array<{ type: string; description: string; amount: Money }>;
  total?: Money;
  ruleVersionId?: string;
  minimum?: Money;
}

export interface Rulebook {
  versionLabel: string;
  sections: Array<{ section: string; rules: Array<{ key: string; title: string; text: string; provenance: string; overrides: Array<{ text: string }> }> }>;
}

export interface AuctionSummary {
  id: string;
  code: string;
  title: string;
  branch: { code: string; name: string; city: string };
  status: string;
  opensAt: string;
  firstCloseAt: string;
  lastCloseAt: string | null;
  staggerSeconds: number;
  depositRequired: boolean;
  lots: number;
  liveLots: number;
  bids: number;
  cover: string | null;
}

export interface LiveLot {
  currentPrice: Money | null;
  bids: number;
  bidders: number;
  endsAt: string;
  extended: boolean;
  closed: boolean;
  reserveStatus: 'no_reserve' | 'met' | 'not_met';
  leading: boolean | null;
  serverTime: string;
}
