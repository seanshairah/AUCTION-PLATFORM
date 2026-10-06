-- =============================================================================
-- ABC Auctions — the System — canonical schema (Phase 0, deliverable 3)
--
-- PostgreSQL 16. One schema per module (docs/01-solution-architecture.md §4).
-- Design notes and rationale: docs/02-data-model.md
--
-- Architecture rules enforced here, not only in application code:
--   R1 one double-entry ledger, append-only, currencies never mixed in a journal
--   R2 one rulebook, versioned and effective-dated; published versions immutable
--   R3 append-only audit of every state change, with actor; two-person overrides
--   R4 idempotency by unique constraints (gateway ref, client request id, message)
--
-- Conventions
--   * Money: bigint minor units + core.currency_code ('USD' | 'ZWG'). No floats.
--   * Signed postings: positive = debit, negative = credit.
--   * Timestamps: timestamptz, stamped by clock_timestamp() (server time).
--   * The application identifies the actor per transaction with
--     audit.set_actor(...) before any audited write; audited writes fail without it.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA core;
CREATE SCHEMA audit;
CREATE SCHEMA rulebook;
CREATE SCHEMA identity;
CREATE SCHEMA ledger;
CREATE SCHEMA payment;
CREATE SCHEMA payout;
CREATE SCHEMA seller;
CREATE SCHEMA catalogue;
CREATE SCHEMA auction;
CREATE SCHEMA registration;
CREATE SCHEMA bidding;
CREATE SCHEMA settlement;
CREATE SCHEMA logistics;
CREATE SCHEMA support;
CREATE SCHEMA comms;
CREATE SCHEMA analytics;

-- -----------------------------------------------------------------------------
-- core: shared types, branches, outbox, idempotency keys
-- -----------------------------------------------------------------------------

CREATE DOMAIN core.currency_code AS char(3)
  CHECK (VALUE IN ('USD', 'ZWG'));             -- ZWG is the ISO 4217 code for ZiG

CREATE TABLE core.branch (
  code          text PRIMARY KEY,               -- 'HRE', 'BYO'
  name          text NOT NULL,
  city          text NOT NULL,
  opening_hours jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Transactional outbox: written in the same transaction as the state change,
-- dispatched at least once by the worker. Consumers must be idempotent.
CREATE TABLE core.outbox (
  id             bigserial PRIMARY KEY,
  topic          text NOT NULL,                  -- e.g. 'bid.accepted', 'invoice.issued'
  aggregate_type text NOT NULL,
  aggregate_id   text NOT NULL,
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at  timestamptz,
  attempts       integer NOT NULL DEFAULT 0
);
CREATE INDEX outbox_pending_idx ON core.outbox (id) WHERE dispatched_at IS NULL;

-- API-level idempotency (R4): a repeated request returns the stored response.
CREATE TABLE core.idempotency_key (
  scope        text NOT NULL,                    -- e.g. 'POST /wallet/top-ups'
  key          text NOT NULL,
  account_id   uuid,
  request_hash bytea NOT NULL,                   -- same key + different body = error
  status_code  integer,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, key)
);

-- -----------------------------------------------------------------------------
-- audit: append-only event log, actor context, staff overrides (R3)
-- -----------------------------------------------------------------------------

CREATE TABLE audit.event (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type  text NOT NULL CHECK (actor_type IN ('account', 'staff', 'system', 'gateway')),
  actor_id    text,
  actor_name  text,
  entity_type text NOT NULL,                     -- 'schema.table'
  entity_id   text NOT NULL,
  action      text NOT NULL,                     -- 'create' | '<column>_change'
  from_state  text,
  to_state    text,
  reason      text,
  request_id  text,
  data        jsonb
);
CREATE INDEX audit_event_entity_idx ON audit.event (entity_type, entity_id, id);

-- Rejects UPDATE and DELETE on append-only tables.
CREATE FUNCTION audit.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only: % is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER event_append_only BEFORE UPDATE OR DELETE ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- Sets the actor for the current transaction. Call before any audited write.
CREATE FUNCTION audit.set_actor(p_type text, p_id text, p_name text,
                                p_reason text DEFAULT NULL, p_request_id text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  SELECT set_config('app.actor_type', p_type, true),
         set_config('app.actor_id', coalesce(p_id, ''), true),
         set_config('app.actor_name', coalesce(p_name, ''), true),
         set_config('app.reason', coalesce(p_reason, ''), true),
         set_config('app.request_id', coalesce(p_request_id, ''), true);
$$;

-- Generic state-change logger.
--   TG_ARGV[0] = state column to watch; TG_ARGV[1] = id column (default 'id').
-- Logs on INSERT and on UPDATE when the watched column changes.
-- Fails if no actor has been set, so no state change can go unattributed.
CREATE FUNCTION audit.log_state_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_col       text := TG_ARGV[0];
  v_idcol     text := coalesce(TG_ARGV[1], 'id');
  v_new       text := to_jsonb(NEW) ->> v_col;
  v_old       text;
  v_actor     text := nullif(current_setting('app.actor_type', true), '');
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD) ->> v_col;
    IF v_old IS NOT DISTINCT FROM v_new THEN
      RETURN NEW;
    END IF;
  END IF;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'audit actor not set: % on %.% must call audit.set_actor() first',
      TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO audit.event (actor_type, actor_id, actor_name, entity_type, entity_id,
                           action, from_state, to_state, reason, request_id)
  VALUES (v_actor,
          nullif(current_setting('app.actor_id', true), ''),
          nullif(current_setting('app.actor_name', true), ''),
          TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
          to_jsonb(NEW) ->> v_idcol,
          CASE TG_OP WHEN 'INSERT' THEN 'create' ELSE v_col || '_change' END,
          v_old, v_new,
          nullif(current_setting('app.reason', true), ''),
          nullif(current_setting('app.request_id', true), ''));
  RETURN NEW;
END $$;

-- Staff overrides: refunds, bid removal, limit changes, fee waivers, payout-detail
-- overrides, lot withdrawal during a live auction. Every one carries a reason.
-- Above the rulebook threshold (A15) a second, different person must approve.
CREATE TABLE audit.override_request (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type              text NOT NULL CHECK (action_type IN
                             ('refund', 'bid_void', 'limit_change', 'fee_waiver',
                              'payout_detail_override', 'lot_withdrawal', 'tier_change',
                              'deposit_forfeit_waiver', 'ledger_adjustment', 'tax_rate_activation')),
  entity_type              text NOT NULL,
  entity_id                text NOT NULL,
  currency                 core.currency_code,
  amount_minor             bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  reason                   text NOT NULL CHECK (length(btrim(reason)) >= 10),
  requested_by             uuid NOT NULL,
  requested_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  requires_second_approval boolean NOT NULL,     -- set from rulebook 'override.two_person_threshold'
  status                   text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'expired')),
  approved_by              uuid,
  decided_at               timestamptz,
  decision_note            text,
  payload                  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- what the override does once approved (deliverable 18)
  expires_at               timestamptz,                         -- lapses unless approved by then (rule override.request_expiry_hours)
  executed_at              timestamptz,
  client_key               text,                                -- R4: a repeated request returns the first
  CONSTRAINT override_request_client_key_unique UNIQUE (requested_by, client_key),
  CONSTRAINT override_request_expiry CHECK (expires_at IS NULL OR expires_at > requested_at),
  CONSTRAINT override_request_rejection_note CHECK (status <> 'rejected' OR length(btrim(coalesce(decision_note, ''))) >= 5),
  CONSTRAINT override_request_executed_at CHECK ((status = 'executed') = (executed_at IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (status NOT IN ('approved', 'executed')
         OR NOT requires_second_approval
         OR approved_by IS NOT NULL),
  CHECK ((amount_minor IS NULL) = (currency IS NULL))
);

CREATE TRIGGER override_request_audit AFTER INSERT OR UPDATE ON audit.override_request
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

-- A request is never edited or deleted: pending -> approved | rejected | expired, approved -> executed | expired,
-- and nothing is approved or executed after it lapses.
CREATE FUNCTION audit.guard_override_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'override requests are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.action_type, NEW.entity_type, NEW.entity_id, NEW.currency, NEW.amount_minor, NEW.reason, NEW.requested_by,
      NEW.requested_at, NEW.requires_second_approval, NEW.payload, NEW.expires_at, NEW.client_key)
     IS DISTINCT FROM
     (OLD.action_type, OLD.entity_type, OLD.entity_id, OLD.currency, OLD.amount_minor, OLD.reason, OLD.requested_by,
      OLD.requested_at, OLD.requires_second_approval, OLD.payload, OLD.expires_at, OLD.client_key) THEN
    RAISE EXCEPTION 'override request % cannot be edited; raise a new request', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'expired'))
            OR (OLD.status = 'approved' AND NEW.status IN ('executed', 'expired'))) THEN
      RAISE EXCEPTION 'override request %: % -> % is not allowed', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('approved', 'executed') AND OLD.expires_at IS NOT NULL AND OLD.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'override request % lapsed at %', OLD.id, OLD.expires_at USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('approved', 'rejected') THEN
      NEW.decided_at := coalesce(NEW.decided_at, clock_timestamp());
    END IF;
    IF NEW.status = 'executed' THEN
      NEW.executed_at := coalesce(NEW.executed_at, clock_timestamp());
    END IF;
  ELSIF OLD.status <> 'pending'
        AND (NEW.approved_by, NEW.decided_at, NEW.decision_note) IS DISTINCT FROM (OLD.approved_by, OLD.decided_at, OLD.decision_note) THEN
    RAISE EXCEPTION 'override request % is decided; the decision cannot change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER override_request_guard BEFORE UPDATE OR DELETE ON audit.override_request
  FOR EACH ROW EXECUTE FUNCTION audit.guard_override_request();

-- Guard for tables that record the execution of an override.
--   TG_ARGV[0] = expected action_type. The row's override_request_id must point
--   to an approved request of that type.
CREATE FUNCTION audit.require_approved_override() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit.override_request o
     WHERE o.id = NEW.override_request_id
       AND o.action_type = TG_ARGV[0]
       AND o.status IN ('approved', 'executed')) THEN
    RAISE EXCEPTION 'override % is not an approved % request', NEW.override_request_id, TG_ARGV[0]
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- rulebook: versioned rules and effective-dated tax rates (R2)
-- Detailed semantics: deliverable 04 (rulebook) and 05 (fee/tax engine).
-- -----------------------------------------------------------------------------

CREATE TABLE rulebook.rule_set_version (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label          text NOT NULL UNIQUE,           -- e.g. '2026.11.01-r1'
  effective_from timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  authored_by    uuid NOT NULL,
  approved_by    uuid,
  published_at   timestamptz,
  notes          text,
  -- publishing a rule set is itself a two-person action
  CHECK (status = 'draft'
         OR (approved_by IS NOT NULL AND approved_by <> authored_by AND published_at IS NOT NULL))
);

CREATE TABLE rulebook.rule_value (
  id          bigserial PRIMARY KEY,
  version_id  uuid NOT NULL REFERENCES rulebook.rule_set_version (id),
  rule_key    text NOT NULL,                     -- e.g. 'bidding.soft_close_seconds'
  scope_type  text NOT NULL DEFAULT 'global'
                CHECK (scope_type IN ('global', 'category', 'tier', 'currency', 'branch', 'auction_format')),
  scope_ref   text NOT NULL DEFAULT '*',
  value       jsonb NOT NULL,
  provenance  text NOT NULL CHECK (provenance IN ('confirmed', 'benchmark', 'proposed', 'assumption')),
  source_note text,                              -- blueprint section or decision reference
  UNIQUE (version_id, rule_key, scope_type, scope_ref)
);

-- Published rule sets are immutable: changes go into a new version.
CREATE FUNCTION rulebook.guard_rule_value() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM rulebook.rule_set_version
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'rule set version is %; published rules are immutable, create a new version', v_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER rule_value_guard BEFORE INSERT OR UPDATE OR DELETE ON rulebook.rule_value
  FOR EACH ROW EXECUTE FUNCTION rulebook.guard_rule_value();

CREATE FUNCTION rulebook.guard_rule_set_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'retired rule set versions cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'published'
     AND (NEW.status <> 'retired' OR NEW.effective_from <> OLD.effective_from
          OR NEW.label <> OLD.label OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'a published rule set version may only be retired' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER rule_set_version_guard BEFORE UPDATE ON rulebook.rule_set_version
  FOR EACH ROW EXECUTE FUNCTION rulebook.guard_rule_set_version();
CREATE TRIGGER rule_set_version_audit AFTER INSERT OR UPDATE ON rulebook.rule_set_version
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

-- Two published versions can never share an effective time, so exactly one is in force at any moment.
CREATE UNIQUE INDEX rule_set_version_one_effective_idx ON rulebook.rule_set_version (effective_from) WHERE status = 'published';

-- Every publication warning is acknowledged by name, with a reason, by the second person (docs/18 §4).
CREATE TABLE rulebook.warning_acknowledgement (
  version_id      uuid NOT NULL REFERENCES rulebook.rule_set_version (id),
  warning_id      text NOT NULL,                 -- stable name: '<code>:<rule key>:<hash of message>'
  code            text NOT NULL,
  rule_key        text,
  message         text NOT NULL,
  reason          text NOT NULL CHECK (length(btrim(reason)) >= 10),
  acknowledged_by uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (version_id, warning_id, acknowledged_by)
);

-- Only a draft's warnings are acknowledged, and never by the draft's author.
CREATE FUNCTION rulebook.guard_warning_acknowledgement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_author uuid;
BEGIN
  SELECT status, authored_by INTO v_status, v_author FROM rulebook.rule_set_version WHERE id = NEW.version_id;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'rule set version is %; only a draft''s warnings are acknowledged', v_status USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.acknowledged_by = v_author THEN
    RAISE EXCEPTION 'the author of a rule set cannot acknowledge its warnings; a second person must' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER warning_acknowledgement_guard BEFORE INSERT ON rulebook.warning_acknowledgement
  FOR EACH ROW EXECUTE FUNCTION rulebook.guard_warning_acknowledgement();
CREATE TRIGGER warning_acknowledgement_append_only BEFORE UPDATE OR DELETE ON rulebook.warning_acknowledgement
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- Tax rates, owned by finance. Rows are effective-dated and never edited in place:
-- a rate change closes the old row (effective_to) and inserts a new one.
CREATE TABLE rulebook.tax_rate (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_code       text NOT NULL CHECK (tax_code IN ('vat', 'purchasers_levy', 'imtt', 'transfer_tax')),
  tax_class      text NOT NULL,                  -- assigned per category, overridable per lot
  currency       core.currency_code NOT NULL,
  rate_bp        integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 100000), -- basis points: 1550 = 15.5 %
  base           text NOT NULL CHECK (base IN ('hammer', 'hammer_plus_premium', 'gross', 'transfer_amount')),
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  active         boolean NOT NULL DEFAULT false, -- Q9: inactive until finance activates
  provenance     text NOT NULL CHECK (provenance IN ('confirmed', 'benchmark', 'proposed', 'assumption')),
  owner          text NOT NULL DEFAULT 'finance',
  approved_by    uuid,
  source_note    text,
  activation_override_id uuid REFERENCES audit.override_request (id),  -- finance's two-person approval (deliverable 18)
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (NOT active OR approved_by IS NOT NULL),
  EXCLUDE USING gist (tax_code WITH =, tax_class WITH =, currency WITH =,
                      tstzrange(effective_from, effective_to) WITH &&) WHERE (active)
);

CREATE FUNCTION rulebook.guard_tax_rate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax rates are never deleted; close them with effective_to'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.tax_code, NEW.tax_class, NEW.currency, NEW.rate_bp, NEW.base, NEW.effective_from)
     IS DISTINCT FROM
     (OLD.tax_code, OLD.tax_class, OLD.currency, OLD.rate_bp, OLD.base, OLD.effective_from) THEN
    RAISE EXCEPTION 'tax rate terms are immutable; close this row and insert a new one'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tax_rate_guard BEFORE UPDATE OR DELETE ON rulebook.tax_rate
  FOR EACH ROW EXECUTE FUNCTION rulebook.guard_tax_rate();
CREATE TRIGGER tax_rate_audit AFTER INSERT OR UPDATE ON rulebook.tax_rate
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('active');

-- Activating a tax rate needs finance's two-person approval (Q9).
CREATE FUNCTION rulebook.guard_tax_activation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active AND NOT OLD.active AND NOT EXISTS (
       SELECT 1 FROM audit.override_request o
        WHERE o.id = NEW.activation_override_id
          AND o.action_type = 'tax_rate_activation'
          AND o.entity_id = NEW.id::text
          AND o.status IN ('approved', 'executed')
          AND o.approved_by IS NOT NULL
          AND o.approved_by = NEW.approved_by) THEN
    RAISE EXCEPTION 'tax rate %: activation needs an approved tax_rate_activation override, approved by a second person', NEW.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tax_rate_activation_guard BEFORE UPDATE OF active ON rulebook.tax_rate
  FOR EACH ROW EXECUTE FUNCTION rulebook.guard_tax_activation();

-- -----------------------------------------------------------------------------
-- identity: accounts, staff roles, devices, ID documents, link signals, consent
-- -----------------------------------------------------------------------------

CREATE TABLE identity.account (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_type       text NOT NULL DEFAULT 'individual' CHECK (account_type IN ('individual', 'organisation')),
  email              citext UNIQUE,
  phone_e164         text UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email_verified_at  timestamptz,
  phone_verified_at  timestamptz,
  display_name       text NOT NULL,
  legal_name         text,
  country            char(2) NOT NULL DEFAULT 'ZW',
  national_id_hmac   bytea UNIQUE,               -- keyed hash for uniqueness checks
  national_id_enc    bytea,                      -- envelope-encrypted copy
  verification_level text NOT NULL DEFAULT 'none' CHECK (verification_level IN ('none', 'partial', 'full')),
  tier               text NOT NULL DEFAULT 'guest' CHECK (tier IN ('guest', 'verified', 'trusted', 'restricted')),
  restricted_until   timestamptz,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  password_hash      text,                       -- argon2id
  totp_secret_enc    bytea,
  mfa_required       boolean NOT NULL DEFAULT false,
  preferred_locale   text NOT NULL DEFAULT 'en-ZW',
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL),
  CHECK ((national_id_hmac IS NULL) = (national_id_enc IS NULL)),
  -- partial = email and phone OTP; full = partial + ID reviewed (CONFIRMED ABC levels)
  CHECK (verification_level <> 'partial' OR (email_verified_at IS NOT NULL AND phone_verified_at IS NOT NULL)),
  CHECK (verification_level <> 'full' OR (email_verified_at IS NOT NULL AND phone_verified_at IS NOT NULL
                                          AND national_id_hmac IS NOT NULL)),
  CHECK (tier = 'guest' OR verification_level <> 'none'),
  CHECK (tier <> 'trusted' OR verification_level = 'full')
);

CREATE TRIGGER account_tier_audit AFTER INSERT OR UPDATE ON identity.account
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('tier');
CREATE TRIGGER account_status_audit AFTER UPDATE ON identity.account
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');
CREATE TRIGGER account_verification_audit AFTER UPDATE ON identity.account
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('verification_level');

CREATE TABLE identity.staff_role (
  account_id uuid NOT NULL REFERENCES identity.account (id),
  role       text NOT NULL CHECK (role IN ('ops', 'finance', 'risk', 'support', 'cashier',
                                           'vehicle_desk', 'admin', 'auditor')),
  granted_by uuid NOT NULL REFERENCES identity.account (id),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, role),
  CHECK (granted_by <> account_id)
);

CREATE TABLE identity.device (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES identity.account (id),
  fingerprint_hmac bytea NOT NULL,
  label            text,
  platform         text NOT NULL CHECK (platform IN ('android', 'ios', 'web', 'pwa')),
  first_seen_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at       timestamptz,
  UNIQUE (account_id, fingerprint_hmac)
);

-- ID images live in the vault bucket; this row is the pointer plus purpose and retention.
CREATE TABLE identity.kyc_document (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES identity.account (id),
  document_type      text NOT NULL CHECK (document_type IN ('national_id', 'passport', 'drivers_licence',
                                                            'company_registration', 'proof_of_address')),
  vault_object_key   text NOT NULL UNIQUE,
  purpose            text NOT NULL,              -- stated purpose (Q8)
  status             text NOT NULL DEFAULT 'submitted'
                       CHECK (status IN ('submitted', 'verified', 'rejected', 'expired')),
  provider           text NOT NULL DEFAULT 'manual_review',
  provider_reference text,
  reviewed_by        uuid REFERENCES identity.account (id),
  reviewed_at        timestamptz,
  retention_until    date NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status = 'submitted' OR reviewed_at IS NOT NULL)
);

CREATE TRIGGER kyc_document_audit AFTER INSERT OR UPDATE ON identity.kyc_document
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

-- Signals used to link accounts for shill-bidding and duplicate-identity control
-- (blueprint §8 risk controls). Values are keyed hashes, never plaintext.
CREATE TABLE identity.link_signal (
  account_id    uuid NOT NULL REFERENCES identity.account (id),
  signal_type   text NOT NULL CHECK (signal_type IN ('device', 'phone', 'national_id', 'payment_source',
                                                     'payout_destination', 'address', 'ip_subnet')),
  signal_hmac   bytea NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, signal_type, signal_hmac)
);
CREATE INDEX link_signal_lookup_idx ON identity.link_signal (signal_type, signal_hmac);

-- Legal consent to be contacted on a channel. Alert choices per category are in comms.preference.
CREATE TABLE identity.contact_consent (
  account_id  uuid NOT NULL REFERENCES identity.account (id),
  channel     text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email', 'push')),
  granted     boolean NOT NULL,
  source      text NOT NULL,                    -- 'signup_form', 'whatsapp_opt_in', ...
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, channel)
);

CREATE TRIGGER contact_consent_audit AFTER INSERT OR UPDATE ON identity.contact_consent
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('granted', 'account_id');

-- -----------------------------------------------------------------------------
-- ledger: the one wallet ledger (R1)
-- -----------------------------------------------------------------------------

-- Book accounts form the chart of accounts. Customer wallets, seller payables,
-- platform income, tax payables, gateway clearing and branch cash are all rows here.
CREATE TABLE ledger.book_account (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type     text NOT NULL CHECK (owner_type IN ('customer', 'seller', 'platform', 'gateway', 'branch')),
  owner_id       text,                           -- account uuid, gateway id or branch code; NULL for platform
  purpose        text NOT NULL CHECK (purpose IN (
                   'wallet_available', 'wallet_held', 'customer_receivable', 'seller_payable',
                   'gateway_clearing', 'branch_cash', 'trust_bank',
                   'commission_income', 'fee_income', 'delivery_income', 'forfeiture_income',
                   'tax_payable', 'fx_clearing', 'suspense', 'write_off')),
  sub_code       text NOT NULL DEFAULT '',       -- e.g. tax code for tax_payable
  currency       core.currency_code NOT NULL,
  normal_side    char(1) NOT NULL CHECK (normal_side IN ('D', 'C')),
  allow_negative boolean NOT NULL,
  balance_minor  bigint NOT NULL DEFAULT 0,      -- maintained only by ledger.apply_posting()
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE NULLS NOT DISTINCT (owner_type, owner_id, purpose, sub_code, currency),
  UNIQUE (id, currency),
  CHECK (allow_negative OR balance_minor >= 0)
);

CREATE TABLE ledger.journal (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN (
                       'top_up', 'branch_cash', 'hold', 'hold_release', 'invoice_issued',
                       'invoice_payment', 'invoice_credit', 'refund', 'forfeit', 'relist_fee',
                       'commission', 'payout', 'gateway_settlement', 'reversal', 'adjustment')),
  currency           core.currency_code NOT NULL,
  idempotency_key    text NOT NULL UNIQUE,       -- R4
  description        text NOT NULL,
  reference_type     text,
  reference_id       text,
  reverses_journal_id uuid UNIQUE REFERENCES ledger.journal (id),
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by_type    text NOT NULL CHECK (created_by_type IN ('account', 'staff', 'system', 'gateway')),
  created_by_id      text,
  UNIQUE (id, currency),
  CHECK ((kind = 'reversal') = (reverses_journal_id IS NOT NULL))
);

-- One row per line. Composite foreign keys make a posting's currency equal to
-- both its journal's and its book account's currency: no journal can mix currencies.
CREATE TABLE ledger.posting (
  id              bigserial PRIMARY KEY,
  journal_id      uuid NOT NULL,
  book_account_id uuid NOT NULL,
  currency        core.currency_code NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor <> 0),  -- + debit, - credit
  FOREIGN KEY (journal_id, currency) REFERENCES ledger.journal (id, currency),
  FOREIGN KEY (book_account_id, currency) REFERENCES ledger.book_account (id, currency)
);
CREATE INDEX posting_journal_idx ON ledger.posting (journal_id);
CREATE INDEX posting_account_idx ON ledger.posting (book_account_id, id);

CREATE TRIGGER journal_append_only BEFORE UPDATE OR DELETE ON ledger.journal
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();
CREATE TRIGGER posting_append_only BEFORE UPDATE OR DELETE ON ledger.posting
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- Maintains the cached balance in the same transaction. The row lock this takes
-- serialises concurrent movements on one account, and the CHECK on book_account
-- rejects any movement that would overdraw a non-negative account.
CREATE FUNCTION ledger.apply_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ledger.book_account
     SET balance_minor = balance_minor
                         + NEW.amount_minor * CASE normal_side WHEN 'D' THEN 1 ELSE -1 END
   WHERE id = NEW.book_account_id;
  RETURN NEW;
END $$;

CREATE TRIGGER posting_apply AFTER INSERT ON ledger.posting
  FOR EACH ROW EXECUTE FUNCTION ledger.apply_posting();

-- Book account identity is immutable; balance changes only through postings.
CREATE FUNCTION ledger.guard_book_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'book accounts are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.owner_type, NEW.owner_id, NEW.purpose, NEW.sub_code, NEW.currency, NEW.normal_side, NEW.allow_negative)
     IS DISTINCT FROM
     (OLD.owner_type, OLD.owner_id, OLD.purpose, OLD.sub_code, OLD.currency, OLD.normal_side, OLD.allow_negative) THEN
    RAISE EXCEPTION 'book account identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.balance_minor <> OLD.balance_minor AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'balances change only through ledger postings' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER book_account_guard BEFORE UPDATE OR DELETE ON ledger.book_account
  FOR EACH ROW EXECUTE FUNCTION ledger.guard_book_account();

-- Every journal must balance to zero and have at least two lines, checked at commit.
CREATE FUNCTION ledger.check_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_journal uuid;
  v_sum     numeric;
  v_lines   integer;
BEGIN
  -- fields are read through jsonb because this trigger serves two tables
  v_journal := coalesce(to_jsonb(NEW) ->> 'journal_id', to_jsonb(NEW) ->> 'id')::uuid;
  SELECT coalesce(sum(amount_minor), 0), count(*) INTO v_sum, v_lines
    FROM ledger.posting WHERE journal_id = v_journal;
  IF v_lines < 2 OR v_sum <> 0 THEN
    RAISE EXCEPTION 'journal % is unbalanced (lines %, sum %)', v_journal, v_lines, v_sum
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON ledger.journal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.check_journal_balanced();
CREATE CONSTRAINT TRIGGER posting_balanced AFTER INSERT ON ledger.posting
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.check_journal_balanced();

-- The ledger module's single write path. Idempotent on p_idempotency_key:
-- a repeated call returns the original journal id and posts nothing.
-- p_lines: [{"account": "<book_account uuid>", "amount": <signed minor units>}, ...]
CREATE FUNCTION ledger.post_journal(p_kind text, p_currency core.currency_code, p_idempotency_key text,
                                    p_description text, p_lines jsonb,
                                    p_reference_type text DEFAULT NULL, p_reference_id text DEFAULT NULL,
                                    p_reverses uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id    uuid;
  v_line  jsonb;
  v_actor text := coalesce(nullif(current_setting('app.actor_type', true), ''), 'system');
BEGIN
  SELECT id INTO v_id FROM ledger.journal WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_id;
  END IF;

  INSERT INTO ledger.journal (kind, currency, idempotency_key, description, reference_type,
                              reference_id, reverses_journal_id, created_by_type, created_by_id)
  VALUES (p_kind, p_currency, p_idempotency_key, p_description, p_reference_type,
          p_reference_id, p_reverses, v_actor, nullif(current_setting('app.actor_id', true), ''))
  RETURNING id INTO v_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO ledger.posting (journal_id, book_account_id, currency, amount_minor)
    VALUES (v_id, (v_line ->> 'account')::uuid, p_currency, (v_line ->> 'amount')::bigint);
  END LOOP;

  RETURN v_id;
END $$;

-- Lifecycle of a deposit hold. Money moves only by journals (hold / hold_release /
-- forfeit); this row says why the money is held and what happened to it.
-- Invariant (checked by daily reconciliation): sum of active holds per customer and
-- currency equals that customer's wallet_held balance.
CREATE TABLE ledger.hold (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES identity.account (id),
  currency          core.currency_code NOT NULL,
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  purpose           text NOT NULL CHECK (purpose IN ('auction_deposit', 'standing_deposit')),
  reference_type    text,
  reference_id      text,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'forfeited')),
  placed_journal_id uuid NOT NULL,
  closed_journal_id uuid,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at         timestamptz,
  FOREIGN KEY (placed_journal_id, currency) REFERENCES ledger.journal (id, currency),
  FOREIGN KEY (closed_journal_id, currency) REFERENCES ledger.journal (id, currency),
  CHECK ((status = 'active') = (closed_journal_id IS NULL)),
  UNIQUE (id, currency)
);

CREATE TRIGGER hold_audit AFTER INSERT OR UPDATE ON ledger.hold
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

-- Wallet view: available and held per customer and currency, read from the ledger itself.
CREATE VIEW ledger.v_wallet AS
SELECT ba.owner_id::uuid AS account_id,
       ba.currency,
       coalesce(sum(ba.balance_minor) FILTER (WHERE ba.purpose = 'wallet_available'), 0)::bigint AS available_minor,
       coalesce(sum(ba.balance_minor) FILTER (WHERE ba.purpose = 'wallet_held'), 0)::bigint      AS held_minor
  FROM ledger.book_account ba
 WHERE ba.owner_type = 'customer'
   AND ba.purpose IN ('wallet_available', 'wallet_held')
 GROUP BY ba.owner_id, ba.currency;

-- -----------------------------------------------------------------------------
-- catalogue: vocabulary, categories, lots, media, vehicles, inspections
-- -----------------------------------------------------------------------------

CREATE TABLE catalogue.item_state_term (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  description text NOT NULL,
  sort        smallint NOT NULL
);

CREATE TABLE catalogue.condition_term (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  description text NOT NULL,
  sort        smallint NOT NULL
);

CREATE TABLE catalogue.category (
  code        text PRIMARY KEY,
  parent_code text REFERENCES catalogue.category (code),
  name        text NOT NULL,
  is_vehicle  boolean NOT NULL DEFAULT false,
  tax_class   text NOT NULL,                     -- default for lots in this category (Q9)
  UNIQUE (code, is_vehicle)
);

CREATE TABLE seller.consignment (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_account_id       uuid NOT NULL REFERENCES identity.account (id),
  consignment_type        text NOT NULL CHECK (consignment_type IN ('commission', 'outright_purchase', 'advance')),
  status                  text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'submitted', 'received', 'signed', 'active', 'closed', 'cancelled')),
  intake_channel          text NOT NULL CHECK (intake_channel IN ('portal', 'app', 'whatsapp', 'branch', 'bulk_api')),
  branch_code             text REFERENCES core.branch (code),
  commission_rule_version uuid REFERENCES rulebook.rule_set_version (id),
  note_object_key         text,                  -- e-signed consignment note
  note_sha256             bytea,                 -- hash of the exact note text the seller signed
  signed_at               timestamptz,
  signature_reference     text,
  advance_minor           bigint CHECK (advance_minor IS NULL OR advance_minor > 0),
  advance_currency        core.currency_code,
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((consignment_type = 'advance') = (advance_minor IS NOT NULL)),
  CHECK ((advance_minor IS NULL) = (advance_currency IS NULL)),
  CHECK (status NOT IN ('signed', 'active', 'closed')
         OR (signed_at IS NOT NULL AND note_object_key IS NOT NULL AND note_sha256 IS NOT NULL
             AND commission_rule_version IS NOT NULL))
);

-- Institutional bulk uploads (banks, insurers, customs sales): one row per file.
CREATE TABLE seller.bulk_batch (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_account_id  uuid NOT NULL REFERENCES identity.account (id),
  external_batch_ref text NOT NULL,
  consignment_id     uuid NOT NULL REFERENCES seller.consignment (id),
  row_count          integer NOT NULL CHECK (row_count > 0),
  created_lot_count  integer NOT NULL CHECK (created_lot_count >= 0),
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (seller_account_id, external_batch_ref)
);

CREATE TRIGGER consignment_audit AFTER INSERT OR UPDATE ON seller.consignment
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

CREATE TABLE catalogue.lot (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_ref                text NOT NULL UNIQUE,   -- human reference, e.g. 'HRE-26-004512'
  consignment_id         uuid NOT NULL REFERENCES seller.consignment (id),
  seller_account_id      uuid NOT NULL REFERENCES identity.account (id),
  category_code          text NOT NULL,
  is_vehicle             boolean NOT NULL,
  title                  text NOT NULL,
  description            text NOT NULL,
  item_state             text NOT NULL REFERENCES catalogue.item_state_term (code),
  condition              text NOT NULL REFERENCES catalogue.condition_term (code),
  condition_notes        text,
  quantity               integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  location_branch        text NOT NULL REFERENCES core.branch (code),
  settlement_currency    core.currency_code NOT NULL,
  tax_class              text NOT NULL,
  starting_bid_minor     bigint NOT NULL CHECK (starting_bid_minor >= 0),
  reserve_minor          bigint CHECK (reserve_minor IS NULL OR reserve_minor > 0),
  estimate_low_minor     bigint,
  estimate_high_minor    bigint,
  state                  text NOT NULL DEFAULT 'draft',
  current_auction_lot_id uuid,                   -- FK added after auction.auction_lot
  external_ref           text,                   -- institution's own lot number (bulk upload, deliverable 13)
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (category_code, is_vehicle) REFERENCES catalogue.category (code, is_vehicle),
  UNIQUE (id, settlement_currency),
  UNIQUE (seller_account_id, external_ref),      -- re-uploading the same file never duplicates lots
  CHECK (estimate_low_minor IS NULL OR estimate_high_minor IS NULL OR estimate_low_minor <= estimate_high_minor)
);
CREATE INDEX lot_state_idx ON catalogue.lot (state);
CREATE INDEX lot_seller_idx ON catalogue.lot (seller_account_id);

-- The lot state machine (docs/02-data-model.md §5). Transitions not listed here are rejected.
CREATE TABLE catalogue.lot_state (
  code        text PRIMARY KEY,
  is_terminal boolean NOT NULL DEFAULT false,
  description text NOT NULL
);

INSERT INTO catalogue.lot_state (code, is_terminal, description) VALUES
  ('draft',           false, 'In intake: details, photos and reserve being prepared'),
  ('listed',          false, 'Published in a scheduled auction; visible, not yet open for bids'),
  ('live',            false, 'Open for bidding'),
  ('closed',          false, 'Bidding ended; result being determined'),
  ('reserve_not_met', false, 'Exception: highest bid below reserve; offer to top bidder, relist or withdraw'),
  ('unsold',          false, 'Closed with no valid bids; relist or withdraw'),
  ('invoiced',        false, 'Invoice issued to the winning bidder'),
  ('payment_overdue', false, 'Exception: pay window passed; default ladder running'),
  ('paid',            false, 'Invoice paid in full'),
  ('title_hold',      false, 'Exception (vehicles): held until ZRP, ZIMRA and CVR steps are complete'),
  ('released',        false, 'Collected or delivered to the buyer'),
  ('paid_out',        true,  'Seller paid; lot complete'),
  ('refunded',        false, 'Dispute upheld; buyer refunded (PROPOSED extension, deliverable 17)'),
  ('withdrawn',       true,  'Removed from sale and returned to the seller');

CREATE TABLE catalogue.lot_state_transition (
  from_state text NOT NULL REFERENCES catalogue.lot_state (code),
  to_state   text NOT NULL REFERENCES catalogue.lot_state (code),
  PRIMARY KEY (from_state, to_state)
);

INSERT INTO catalogue.lot_state_transition (from_state, to_state) VALUES
  ('draft', 'listed'), ('draft', 'withdrawn'),
  ('listed', 'live'), ('listed', 'draft'), ('listed', 'withdrawn'),
  ('live', 'closed'), ('live', 'withdrawn'),
  ('closed', 'invoiced'), ('closed', 'reserve_not_met'), ('closed', 'unsold'),
  ('reserve_not_met', 'invoiced'), ('reserve_not_met', 'listed'), ('reserve_not_met', 'withdrawn'),
  ('unsold', 'listed'), ('unsold', 'withdrawn'),
  ('invoiced', 'paid'), ('invoiced', 'payment_overdue'),
  ('payment_overdue', 'paid'), ('payment_overdue', 'listed'), ('payment_overdue', 'withdrawn'),
  ('paid', 'released'), ('paid', 'title_hold'), ('paid', 'refunded'),
  ('title_hold', 'released'), ('title_hold', 'refunded'),
  ('released', 'paid_out'), ('released', 'refunded'),
  ('refunded', 'listed'), ('refunded', 'withdrawn');

ALTER TABLE catalogue.lot
  ADD FOREIGN KEY (state) REFERENCES catalogue.lot_state (code);

CREATE FUNCTION catalogue.guard_lot_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' THEN
      RAISE EXCEPTION 'a lot starts in draft, not %', NEW.state USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.is_vehicle IS DISTINCT FROM OLD.is_vehicle AND OLD.state <> 'draft' THEN
    RAISE EXCEPTION 'vehicle flag is fixed once a lot leaves draft' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM catalogue.lot_state_transition
                  WHERE from_state = OLD.state AND to_state = NEW.state) THEN
    RAISE EXCEPTION 'lot %: transition % -> % is not allowed', NEW.lot_ref, OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  -- Vehicles always pass through the title hold; other lots never do.
  IF NEW.is_vehicle AND OLD.state = 'paid' AND NEW.state = 'released' THEN
    RAISE EXCEPTION 'lot %: a vehicle is released only after its title steps (title_hold)', NEW.lot_ref
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT NEW.is_vehicle AND NEW.state = 'title_hold' THEN
    RAISE EXCEPTION 'lot %: only vehicles enter title_hold', NEW.lot_ref USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.is_vehicle AND NEW.state = 'released' AND NOT EXISTS (
       SELECT 1 FROM logistics.title_case tc WHERE tc.lot_id = NEW.id AND tc.status = 'complete') THEN
    RAISE EXCEPTION 'lot %: title case is not complete', NEW.lot_ref USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER lot_state_guard BEFORE INSERT OR UPDATE ON catalogue.lot
  FOR EACH ROW EXECUTE FUNCTION catalogue.guard_lot_state();
CREATE TRIGGER lot_state_audit AFTER INSERT OR UPDATE ON catalogue.lot
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('state');

CREATE TABLE catalogue.lot_media (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id     uuid NOT NULL REFERENCES catalogue.lot (id),
  kind       text NOT NULL CHECK (kind IN ('photo', 'video', 'document')),
  role       text NOT NULL,                      -- 'overall', 'label', 'defect', 'odometer', 'chassis_plate', ...
  object_key text NOT NULL UNIQUE,
  width      integer,
  height     integer,
  bytes      bigint,
  sort       smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX lot_media_lot_idx ON catalogue.lot_media (lot_id, sort);

CREATE TABLE catalogue.vehicle (
  lot_id              uuid PRIMARY KEY REFERENCES catalogue.lot (id),
  make                text NOT NULL,
  model               text NOT NULL,
  year                smallint CHECK (year BETWEEN 1900 AND 2100),
  chassis_number      text NOT NULL,
  engine_number       text,
  registration_number text,
  zimbabwe_registered boolean NOT NULL,          -- drives tax class (BENCHMARK: VAT exemption, Q9)
  odometer_km         integer CHECK (odometer_km >= 0),
  fuel                text,
  transmission        text,
  colour              text,
  documents_status    text NOT NULL DEFAULT 'unknown' CHECK (documents_status IN ('complete', 'incomplete', 'unknown')),
  body_style          text CHECK (body_style IN ('sedan', 'hatchback', 'suv', 'pickup', 'van', 'truck', 'bus', 'coupe', 'wagon', 'other')),
  drive               text CHECK (drive IN ('2wd', '4wd', 'awd'))   -- migration 0001
);
CREATE INDEX vehicle_chassis_idx ON catalogue.vehicle (chassis_number);
CREATE INDEX vehicle_make_model_idx ON catalogue.vehicle (make, model);

-- Detailed checklist and remedy: deliverable 14.
CREATE TABLE catalogue.inspection_report (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id            uuid NOT NULL REFERENCES catalogue.lot (id),
  checklist_version text NOT NULL,
  inspector_id      uuid NOT NULL REFERENCES identity.account (id),
  inspected_at      timestamptz NOT NULL,
  chassis_verified  boolean NOT NULL,
  engine_verified   boolean NOT NULL,
  chassis_number_seen text,                      -- as read off the vehicle by the inspector
  engine_number_seen  text,
  odometer_km       integer CHECK (odometer_km IS NULL OR odometer_km >= 0),
  items             jsonb NOT NULL,              -- checklist answers keyed by checklist item
  photo_count       integer NOT NULL CHECK (photo_count >= 0),
  has_video         boolean NOT NULL,
  summary           text NOT NULL,
  published_at      timestamptz
);
CREATE INDEX inspection_report_lot_idx ON catalogue.inspection_report (lot_id);

-- A published inspection report is evidence for the gross-inaccuracy remedy
-- (deliverable 14): it is never edited. A re-inspection is a new report.
CREATE FUNCTION catalogue.guard_inspection_report() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'published inspection reports are never deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'inspection report % is published and cannot change; file a new report', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER inspection_report_guard BEFORE UPDATE OR DELETE ON catalogue.inspection_report
  FOR EACH ROW EXECUTE FUNCTION catalogue.guard_inspection_report();
CREATE TRIGGER inspection_report_audit AFTER INSERT OR UPDATE ON catalogue.inspection_report
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('published_at');

-- Viewing slots replace arranging viewings by phone and email (blueprint module 8).
CREATE TABLE catalogue.viewing_slot (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_code text NOT NULL REFERENCES core.branch (code),
  lot_id      uuid REFERENCES catalogue.lot (id),   -- NULL: a general viewing window for the branch
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  capacity    integer NOT NULL CHECK (capacity > 0),
  CHECK (ends_at > starts_at)
);
CREATE INDEX viewing_slot_lot_idx ON catalogue.viewing_slot (lot_id, starts_at);

CREATE TABLE catalogue.viewing_booking (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id    uuid NOT NULL REFERENCES catalogue.viewing_slot (id),
  account_id uuid NOT NULL REFERENCES identity.account (id),
  status     text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled', 'attended', 'no_show')),
  booked_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX viewing_booking_once_idx ON catalogue.viewing_booking (slot_id, account_id) WHERE status <> 'cancelled';

-- A slot never holds more active bookings than its capacity (checked under a row lock on the slot).
CREATE FUNCTION catalogue.guard_viewing_capacity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_capacity integer;
  v_booked   integer;
BEGIN
  IF NEW.status <> 'booked' THEN
    RETURN NEW;
  END IF;
  SELECT capacity INTO v_capacity FROM catalogue.viewing_slot WHERE id = NEW.slot_id FOR UPDATE;
  SELECT count(*) INTO v_booked FROM catalogue.viewing_booking
   WHERE slot_id = NEW.slot_id AND status = 'booked' AND id <> NEW.id;
  IF v_booked >= v_capacity THEN
    RAISE EXCEPTION 'viewing slot % is full', NEW.slot_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER viewing_booking_capacity BEFORE INSERT OR UPDATE OF status ON catalogue.viewing_booking
  FOR EACH ROW EXECUTE FUNCTION catalogue.guard_viewing_capacity();

CREATE TABLE catalogue.saved_search (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES identity.account (id),
  name          text NOT NULL,
  query         jsonb NOT NULL,                  -- category, keywords, branch, price band, currency
  alerts_on     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- -----------------------------------------------------------------------------
-- auction: auctions and lots within them (bidding state lives on auction_lot)
-- -----------------------------------------------------------------------------

CREATE TABLE auction.auction (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE,
  title              text NOT NULL,
  format             text NOT NULL CHECK (format IN ('timed_online', 'floor', 'out_of_hand')),
  branch_code        text NOT NULL REFERENCES core.branch (code),
  status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'scheduled', 'open', 'closing', 'closed', 'cancelled')),
  rule_version_id    uuid REFERENCES rulebook.rule_set_version (id),  -- pinned at opening (A20)
  opens_at           timestamptz NOT NULL,
  first_close_at     timestamptz NOT NULL,
  stagger_seconds    integer NOT NULL DEFAULT 0 CHECK (stagger_seconds >= 0),
  soft_close_seconds integer CHECK (soft_close_seconds IS NULL OR soft_close_seconds > 0), -- NULL = rulebook default
  experiment_variant text,                       -- soft-close A/B label (deliverable 8)
  deposit_required   boolean NOT NULL DEFAULT false,
  created_by         uuid NOT NULL REFERENCES identity.account (id),
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (first_close_at > opens_at),
  CHECK (status IN ('draft', 'scheduled', 'cancelled') OR rule_version_id IS NOT NULL)
);

CREATE TRIGGER auction_audit AFTER INSERT OR UPDATE ON auction.auction
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

CREATE TABLE auction.auction_lot (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id          uuid NOT NULL REFERENCES auction.auction (id),
  lot_id              uuid NOT NULL,
  currency            core.currency_code NOT NULL,
  lot_number          integer NOT NULL CHECK (lot_number > 0),
  starting_bid_minor  bigint NOT NULL CHECK (starting_bid_minor >= 0),
  reserve_minor       bigint CHECK (reserve_minor IS NULL OR reserve_minor > 0), -- never exposed to bidders
  increment_table_key text NOT NULL DEFAULT 'default',
  scheduled_end_at    timestamptz NOT NULL,
  current_end_at      timestamptz NOT NULL,
  extension_count     integer NOT NULL DEFAULT 0 CHECK (extension_count >= 0),
  bid_seq             bigint NOT NULL DEFAULT 0, -- last issued bid sequence number
  current_price_minor bigint,
  leading_bid_id      uuid,
  leading_account_id  uuid REFERENCES identity.account (id),
  reserve_met         boolean GENERATED ALWAYS AS
                        (reserve_minor IS NULL OR coalesce(current_price_minor, 0) >= reserve_minor) STORED,
  result              text NOT NULL DEFAULT 'pending'
                        CHECK (result IN ('pending', 'sold', 'reserve_not_met', 'unsold', 'withdrawn')),
  hammer_minor        bigint,
  winner_account_id   uuid REFERENCES identity.account (id),
  closed_at           timestamptz,
  FOREIGN KEY (lot_id, currency) REFERENCES catalogue.lot (id, settlement_currency),
  UNIQUE (auction_id, lot_number),
  UNIQUE (auction_id, lot_id),
  UNIQUE (id, currency),
  CHECK (current_end_at >= scheduled_end_at),
  CHECK ((result = 'sold') = (hammer_minor IS NOT NULL AND winner_account_id IS NOT NULL)),
  CHECK (result = 'pending' OR closed_at IS NOT NULL)
);
CREATE INDEX auction_lot_closing_idx ON auction.auction_lot (current_end_at) WHERE result = 'pending';

CREATE TRIGGER auction_lot_audit AFTER INSERT OR UPDATE ON auction.auction_lot
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('result');

ALTER TABLE catalogue.lot
  ADD FOREIGN KEY (current_auction_lot_id) REFERENCES auction.auction_lot (id);

-- -----------------------------------------------------------------------------
-- registration: the right to bid in one auction, and approved limit overrides
-- -----------------------------------------------------------------------------

CREATE TABLE registration.registration (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES identity.account (id),
  auction_id      uuid NOT NULL REFERENCES auction.auction (id),
  status          text NOT NULL CHECK (status IN ('approved', 'pending_review', 'rejected', 'revoked')),
  decided_by_type text CHECK (decided_by_type IN ('system', 'staff')),
  decided_by      uuid REFERENCES identity.account (id),
  decided_at      timestamptz,
  flag_reasons    text[] NOT NULL DEFAULT '{}',
  limit_snapshot  jsonb NOT NULL,                -- per currency at decision time: limit and its composition
  deposit_hold_id uuid REFERENCES ledger.hold (id),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  decision_note   text,                          -- staff decisions on the review queue (deliverable 18)
  CONSTRAINT registration_staff_decision_note
    CHECK (decided_by_type IS DISTINCT FROM 'staff' OR length(btrim(coalesce(decision_note, ''))) >= 10),
  UNIQUE (account_id, auction_id),
  CHECK (status = 'pending_review' OR (decided_at IS NOT NULL AND decided_by_type IS NOT NULL)),
  CHECK (decided_by_type IS DISTINCT FROM 'staff' OR decided_by IS NOT NULL),
  CHECK (status <> 'pending_review' OR cardinality(flag_reasons) > 0)
);

CREATE TRIGGER registration_audit AFTER INSERT OR UPDATE ON registration.registration
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

-- Pending registrations are decided once; an approval can later be revoked.
CREATE FUNCTION registration.guard_registration_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'pending_review' AND NEW.status IN ('approved', 'rejected'))
              OR (OLD.status = 'approved' AND NEW.status = 'revoked')) THEN
    RAISE EXCEPTION 'registration %: % -> % is not allowed', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER registration_status_guard BEFORE UPDATE OF status ON registration.registration
  FOR EACH ROW EXECUTE FUNCTION registration.guard_registration_status();

CREATE TABLE registration.limit_override (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES identity.account (id),
  currency            core.currency_code NOT NULL,
  limit_minor         bigint NOT NULL CHECK (limit_minor >= 0),
  valid_until         timestamptz NOT NULL,
  override_request_id uuid NOT NULL REFERENCES audit.override_request (id),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER limit_override_requires_approval BEFORE INSERT ON registration.limit_override
  FOR EACH ROW EXECUTE FUNCTION audit.require_approved_override('limit_change');
CREATE TRIGGER limit_override_append_only BEFORE UPDATE OR DELETE ON registration.limit_override
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- -----------------------------------------------------------------------------
-- bidding: the immutable bid log
-- -----------------------------------------------------------------------------

CREATE TABLE bidding.bid (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_lot_id         uuid NOT NULL,
  currency               core.currency_code NOT NULL,
  account_id             uuid NOT NULL REFERENCES identity.account (id),
  registration_id        uuid NOT NULL REFERENCES registration.registration (id),
  origin                 text NOT NULL CHECK (origin IN ('bidder', 'proxy', 'floor_clerk')),
  parent_bid_id          uuid REFERENCES bidding.bid (id), -- proxy bids point at the max bid that produced them
  client_request_id      text,                   -- R4: idempotency per account
  sequence_no            bigint NOT NULL CHECK (sequence_no > 0),
  amount_minor           bigint NOT NULL CHECK (amount_minor > 0),
  max_amount_minor       bigint,                 -- proxy ceiling; secret to other bidders
  outcome_at_placement   text NOT NULL CHECK (outcome_at_placement IN ('leading', 'outbid', 'rejected')),
  reject_reason          text,
  quoted_total_minor     bigint,                 -- all-in total shown on the commit screen
  quoted_rule_version_id uuid REFERENCES rulebook.rule_set_version (id),
  server_received_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  channel                text NOT NULL CHECK (channel IN ('web', 'pwa', 'android', 'ios', 'admin', 'floor')),
  device_id              uuid REFERENCES identity.device (id),
  FOREIGN KEY (auction_lot_id, currency) REFERENCES auction.auction_lot (id, currency),
  UNIQUE (auction_lot_id, sequence_no),
  UNIQUE (account_id, client_request_id),
  CHECK (origin <> 'bidder' OR (client_request_id IS NOT NULL AND max_amount_minor IS NOT NULL
                                AND max_amount_minor >= amount_minor
                                AND quoted_total_minor IS NOT NULL AND quoted_rule_version_id IS NOT NULL)),
  CHECK (origin <> 'proxy' OR parent_bid_id IS NOT NULL),
  CHECK ((outcome_at_placement = 'rejected') = (reject_reason IS NOT NULL))
);
CREATE INDEX bid_lot_idx ON bidding.bid (auction_lot_id, sequence_no);
CREATE INDEX bid_account_idx ON bidding.bid (account_id, server_received_at);

ALTER TABLE auction.auction_lot
  ADD FOREIGN KEY (leading_bid_id) REFERENCES bidding.bid (id);

CREATE TRIGGER bid_append_only BEFORE UPDATE OR DELETE ON bidding.bid
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();
CREATE TRIGGER bid_audit AFTER INSERT ON bidding.bid
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('outcome_at_placement');

-- Network context for a bid, kept apart from the append-only bid log so it can be
-- pruned under the retention policy (docs/02-data-model.md §9).
CREATE TABLE bidding.bid_network (
  bid_id      uuid PRIMARY KEY REFERENCES bidding.bid (id),
  ip          inet,
  user_agent  text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Bid removal by staff: the bid row stays; this row voids it (blueprint module 5:
-- "No bid withdrawal except by admin with a logged reason").
CREATE TABLE bidding.bid_void (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id              uuid NOT NULL UNIQUE REFERENCES bidding.bid (id),
  override_request_id uuid NOT NULL REFERENCES audit.override_request (id),
  voided_by           uuid NOT NULL REFERENCES identity.account (id),
  reason              text NOT NULL CHECK (length(btrim(reason)) >= 10),
  voided_at           timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER bid_void_requires_approval BEFORE INSERT ON bidding.bid_void
  FOR EACH ROW EXECUTE FUNCTION audit.require_approved_override('bid_void');
CREATE TRIGGER bid_void_append_only BEFORE UPDATE OR DELETE ON bidding.bid_void
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- -----------------------------------------------------------------------------
-- settlement: invoices and the default ladder
-- -----------------------------------------------------------------------------

CREATE TABLE settlement.invoice (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number     text NOT NULL UNIQUE,
  buyer_account_id   uuid NOT NULL REFERENCES identity.account (id),
  auction_id         uuid NOT NULL REFERENCES auction.auction (id),
  currency           core.currency_code NOT NULL,
  status             text NOT NULL DEFAULT 'issued'
                       CHECK (status IN ('issued', 'paid', 'overdue', 'defaulted', 'void', 'credited')),
  rule_version_id    uuid NOT NULL REFERENCES rulebook.rule_set_version (id),  -- rates frozen at the hammer
  issued_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  due_at             timestamptz NOT NULL,
  collect_by_at      timestamptz NOT NULL,
  total_minor        bigint NOT NULL CHECK (total_minor >= 0),
  issue_journal_id   uuid,
  paid_at            timestamptz,
  FOREIGN KEY (issue_journal_id, currency) REFERENCES ledger.journal (id, currency),
  UNIQUE (id, currency),
  CHECK (due_at > issued_at),
  CHECK (collect_by_at > due_at),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL) OR status IN ('credited'))
);
CREATE INDEX invoice_buyer_idx ON settlement.invoice (buyer_account_id, issued_at);
CREATE INDEX invoice_due_idx ON settlement.invoice (due_at) WHERE status = 'issued';

CREATE TRIGGER invoice_audit AFTER INSERT OR UPDATE ON settlement.invoice
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

-- Lines are immutable once written: corrections are credit notes, never edits.
-- The currency foreign keys make every line's currency equal to its invoice's
-- and its auction lot's, so nothing is ever converted silently.
CREATE TABLE settlement.invoice_line (
  id             bigserial PRIMARY KEY,
  invoice_id     uuid NOT NULL,
  currency       core.currency_code NOT NULL,
  lot_id         uuid REFERENCES catalogue.lot (id),
  auction_lot_id uuid,
  line_type      text NOT NULL CHECK (line_type IN ('hammer', 'buyers_premium', 'vat', 'purchasers_levy',
                                                    'imtt', 'transfer_tax', 'delivery', 'storage',
                                                    'relist_fee', 'late_fee', 'adjustment')),
  description    text NOT NULL,
  base_minor     bigint,
  rate_bp        integer,
  amount_minor   bigint NOT NULL,
  tax_rate_id    uuid REFERENCES rulebook.tax_rate (id),
  sort           smallint NOT NULL DEFAULT 0,
  FOREIGN KEY (invoice_id, currency) REFERENCES settlement.invoice (id, currency),
  FOREIGN KEY (auction_lot_id, currency) REFERENCES auction.auction_lot (id, currency),
  CHECK (line_type NOT IN ('vat', 'purchasers_levy', 'imtt', 'transfer_tax') OR tax_rate_id IS NOT NULL)
);
CREATE INDEX invoice_line_invoice_idx ON settlement.invoice_line (invoice_id);

CREATE TRIGGER invoice_line_append_only BEFORE UPDATE OR DELETE ON settlement.invoice_line
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- Invoice total must equal the sum of its lines, checked at commit.
CREATE FUNCTION settlement.check_invoice_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_invoice uuid;
  v_total   bigint;
  v_sum     numeric;
BEGIN
  v_invoice := coalesce(to_jsonb(NEW) ->> 'invoice_id', to_jsonb(NEW) ->> 'id')::uuid;
  SELECT total_minor INTO v_total FROM settlement.invoice WHERE id = v_invoice;
  SELECT coalesce(sum(amount_minor), 0) INTO v_sum FROM settlement.invoice_line WHERE invoice_id = v_invoice;
  IF v_sum <> v_total THEN
    RAISE EXCEPTION 'invoice %: total % does not equal sum of lines %', v_invoice, v_total, v_sum
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER invoice_total_matches AFTER INSERT OR UPDATE OF total_minor ON settlement.invoice
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION settlement.check_invoice_total();
CREATE CONSTRAINT TRIGGER invoice_line_total_matches AFTER INSERT ON settlement.invoice_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION settlement.check_invoice_total();

-- Default ladder (blueprint module 7): warning -> deposit forfeit -> relist fee -> tier drop.
CREATE TABLE settlement.default_case (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL UNIQUE REFERENCES settlement.invoice (id),
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cured', 'completed', 'waived')),
  opened_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at  timestamptz,
  CHECK ((status = 'open') = (closed_at IS NULL))
);

CREATE TRIGGER default_case_audit AFTER INSERT OR UPDATE ON settlement.default_case
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

CREATE TABLE settlement.default_step (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  default_case_id uuid NOT NULL REFERENCES settlement.default_case (id),
  step            text NOT NULL CHECK (step IN ('warning', 'deposit_forfeit', 'relist_fee', 'tier_drop')),
  applied_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  journal_id      uuid REFERENCES ledger.journal (id),   -- forfeit and relist fee move money
  UNIQUE (default_case_id, step),
  CHECK (step NOT IN ('deposit_forfeit', 'relist_fee') OR journal_id IS NOT NULL)
);

CREATE TRIGGER default_step_append_only BEFORE UPDATE OR DELETE ON settlement.default_step
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- Appeals against the default ladder, and waivers of its steps (deliverable 18).
CREATE TABLE settlement.default_appeal (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  default_case_id uuid NOT NULL REFERENCES settlement.default_case (id),
  raised_by       uuid NOT NULL REFERENCES identity.account (id),
  raised_via      text NOT NULL CHECK (raised_via IN ('buyer', 'staff')),
  steps           text[] NOT NULL CHECK (cardinality(steps) > 0
                                         AND steps <@ ARRAY['deposit_forfeit', 'relist_fee', 'tier_drop']::text[]),
  grounds         text NOT NULL CHECK (length(btrim(grounds)) >= 10),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'partly_upheld', 'rejected', 'withdrawn')),
  decided_by      uuid REFERENCES identity.account (id),
  decided_at      timestamptz,
  decision_note   text,
  raised_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status IN ('open', 'withdrawn')
         OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND length(btrim(coalesce(decision_note, ''))) >= 10))
);
CREATE UNIQUE INDEX default_appeal_one_open_idx ON settlement.default_appeal (default_case_id) WHERE status = 'open';

CREATE TRIGGER default_appeal_audit AFTER INSERT OR UPDATE ON settlement.default_appeal
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

-- A waived step is either prevented (it never runs) or reversed (journals put the money back).
CREATE TABLE settlement.default_waiver (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  default_case_id     uuid NOT NULL REFERENCES settlement.default_case (id),
  appeal_id           uuid REFERENCES settlement.default_appeal (id),
  step                text NOT NULL CHECK (step IN ('deposit_forfeit', 'relist_fee', 'tier_drop')),
  effect              text NOT NULL CHECK (effect IN ('prevented', 'reversed')),
  override_request_id uuid NOT NULL REFERENCES audit.override_request (id),
  journal_ids         uuid[] NOT NULL DEFAULT '{}',
  reason              text NOT NULL CHECK (length(btrim(reason)) >= 10),
  waived_by           uuid NOT NULL REFERENCES identity.account (id),
  waived_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (default_case_id, step),
  CHECK (effect = 'reversed' OR cardinality(journal_ids) = 0),
  CHECK (step <> 'relist_fee' OR effect <> 'reversed' OR cardinality(journal_ids) > 0)
);

-- The override behind a waiver must be approved, of the type that matches the step, for this case.
CREATE FUNCTION settlement.guard_default_waiver() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM audit.override_request o
        WHERE o.id = NEW.override_request_id
          AND o.entity_type = 'settlement.default_case'
          AND o.entity_id = NEW.default_case_id::text
          AND o.status IN ('approved', 'executed')
          AND o.action_type = CASE NEW.step WHEN 'deposit_forfeit' THEN 'deposit_forfeit_waiver'
                                            WHEN 'relist_fee' THEN 'fee_waiver'
                                            ELSE 'tier_change' END) THEN
    RAISE EXCEPTION 'waiver of % needs an approved override for this default case', NEW.step
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER default_waiver_requires_approval BEFORE INSERT ON settlement.default_waiver
  FOR EACH ROW EXECUTE FUNCTION settlement.guard_default_waiver();
CREATE TRIGGER default_waiver_append_only BEFORE UPDATE OR DELETE ON settlement.default_waiver
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();
CREATE TRIGGER default_waiver_audit AFTER INSERT ON settlement.default_waiver
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('effect');

-- A waived step is never applied afterwards, whoever runs the ladder.
CREATE FUNCTION settlement.guard_waived_step() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM settlement.default_waiver w WHERE w.default_case_id = NEW.default_case_id AND w.step = NEW.step) THEN
    RAISE EXCEPTION 'default step % was waived for this case and cannot be applied', NEW.step USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER default_step_not_waived BEFORE INSERT ON settlement.default_step
  FOR EACH ROW EXECUTE FUNCTION settlement.guard_waived_step();

-- -----------------------------------------------------------------------------
-- payment: gateway and branch-cash payments, callbacks, reconciliation
-- -----------------------------------------------------------------------------

CREATE TABLE payment.payment (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES identity.account (id),
  purpose                text NOT NULL CHECK (purpose IN ('top_up', 'invoice')),
  invoice_id             uuid,
  method                 text NOT NULL CHECK (method IN ('ecocash', 'onemoney', 'innbucks', 'omari', 'zimswitch',
                                                         'card', 'bank_transfer', 'branch_cash', 'wallet')),
  gateway                text NOT NULL,          -- 'paynow', 'contipay', 'branch', 'internal'
  currency               core.currency_code NOT NULL,
  amount_minor           bigint NOT NULL CHECK (amount_minor > 0),
  status                 text NOT NULL DEFAULT 'initiated'
                           CHECK (status IN ('initiated', 'pending', 'succeeded', 'failed',
                                             'cancelled', 'expired', 'reversed')),
  client_idempotency_key text NOT NULL,
  gateway_reference      text,
  branch_code            text REFERENCES core.branch (code),
  receipt_number         text UNIQUE,            -- branch cash receipts
  cashier_id             uuid REFERENCES identity.account (id),
  journal_id             uuid UNIQUE,
  failure_reason         text,
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at           timestamptz,
  FOREIGN KEY (invoice_id, currency) REFERENCES settlement.invoice (id, currency),
  FOREIGN KEY (journal_id, currency) REFERENCES ledger.journal (id, currency),
  UNIQUE (account_id, client_idempotency_key),   -- R4: client retries
  UNIQUE (gateway, gateway_reference),           -- R4: gateway callbacks
  CHECK ((purpose = 'invoice') = (invoice_id IS NOT NULL)),
  CHECK (method <> 'branch_cash'
         OR (gateway = 'branch' AND receipt_number IS NOT NULL AND branch_code IS NOT NULL AND cashier_id IS NOT NULL)),
  CHECK (method <> 'wallet' OR (gateway = 'internal' AND purpose = 'invoice')),
  CHECK (status <> 'succeeded' OR (journal_id IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (method <> 'innbucks' OR currency = 'USD')  -- blueprint §7: InnBucks is USD only
);
CREATE INDEX payment_account_idx ON payment.payment (account_id, created_at);
CREATE INDEX payment_pending_idx ON payment.payment (created_at) WHERE status IN ('initiated', 'pending');

CREATE TRIGGER payment_audit AFTER INSERT OR UPDATE ON payment.payment
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

-- Every callback received, verified or not, kept verbatim for disputes and reconciliation.
CREATE TABLE payment.gateway_event (
  id                bigserial PRIMARY KEY,
  gateway           text NOT NULL,
  gateway_reference text,
  payment_id        uuid REFERENCES payment.payment (id),
  event_type        text NOT NULL,
  signature_valid   boolean NOT NULL,
  payload_sha256    bytea NOT NULL,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX gateway_event_ref_idx ON payment.gateway_event (gateway, gateway_reference);

CREATE TRIGGER gateway_event_append_only BEFORE UPDATE OR DELETE ON payment.gateway_event
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

CREATE TABLE payment.reconciliation_run (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL,                 -- gateway id, 'branch:HRE', 'bank:trust'
  currency        core.currency_code NOT NULL,
  statement_date  date NOT NULL,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'balanced', 'exceptions', 'failed')),
  matched_count   integer NOT NULL DEFAULT 0,
  exception_count integer NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at     timestamptz,
  UNIQUE (source, currency, statement_date)
);

CREATE TABLE payment.reconciliation_item (
  id                     bigserial PRIMARY KEY,
  run_id                 uuid NOT NULL REFERENCES payment.reconciliation_run (id),
  external_reference     text,
  statement_amount_minor bigint,
  payment_id             uuid REFERENCES payment.payment (id),
  outcome                text NOT NULL CHECK (outcome IN ('matched', 'missing_in_system', 'missing_at_source',
                                                          'amount_mismatch', 'currency_mismatch')),
  resolved_by            uuid REFERENCES identity.account (id),
  resolved_at            timestamptz,
  resolution_note        text,
  resolution             text CHECK (resolution IN ('matched_manually', 'gateway_error', 'within_tolerance', 'written_off')),
  override_request_id    uuid REFERENCES audit.override_request (id),   -- write-offs only
  journal_id             uuid REFERENCES ledger.journal (id),           -- write-offs only
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
  CONSTRAINT reconciliation_item_resolution_complete CHECK ((resolution IS NULL) = (resolved_at IS NULL)),
  CONSTRAINT reconciliation_item_resolution_note CHECK (resolution IS NULL OR length(btrim(coalesce(resolution_note, ''))) >= 10),
  CONSTRAINT reconciliation_item_write_off CHECK (resolution IS DISTINCT FROM 'written_off'
                                                  OR (journal_id IS NOT NULL AND override_request_id IS NOT NULL))
);

-- A resolution is final; matched items need none; a write-off needs an approved ledger adjustment.
CREATE FUNCTION payment.guard_reconciliation_item() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reconciliation items are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'reconciliation item % is already resolved', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.run_id, NEW.external_reference, NEW.statement_amount_minor, NEW.outcome)
     IS DISTINCT FROM (OLD.run_id, OLD.external_reference, OLD.statement_amount_minor, OLD.outcome) THEN
    RAISE EXCEPTION 'reconciliation item % records what the statement said; it cannot be edited', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.resolution IS NOT NULL AND OLD.outcome = 'matched' THEN
    RAISE EXCEPTION 'reconciliation item % matched; there is nothing to resolve', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.resolution = 'written_off' AND NOT EXISTS (
       SELECT 1 FROM audit.override_request o
        WHERE o.id = NEW.override_request_id AND o.action_type = 'ledger_adjustment'
          AND o.entity_type = 'payment.reconciliation_item' AND o.entity_id = OLD.id::text
          AND o.status IN ('approved', 'executed') AND o.approved_by IS NOT NULL) THEN
    RAISE EXCEPTION 'reconciliation item %: a write-off needs a ledger adjustment approved by a second person', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER reconciliation_item_guard BEFORE UPDATE OR DELETE ON payment.reconciliation_item
  FOR EACH ROW EXECUTE FUNCTION payment.guard_reconciliation_item();
CREATE TRIGGER reconciliation_item_audit AFTER UPDATE ON payment.reconciliation_item
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('resolution');

-- -----------------------------------------------------------------------------
-- logistics: collections, QR passes, slots, vehicle title cases
-- -----------------------------------------------------------------------------

-- Towing and courier partners listed to buyers (blueprint module 8: "Towing partners listed").
CREATE TABLE logistics.partner (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('towing', 'courier')),
  name       text NOT NULL,
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  branches   text[] NOT NULL CHECK (cardinality(branches) > 0),
  notes      text,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (kind, name)
);

CREATE TABLE logistics.collection_slot (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_code text NOT NULL REFERENCES core.branch (code),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  capacity    integer NOT NULL CHECK (capacity > 0),
  UNIQUE (branch_code, starts_at),
  CHECK (ends_at > starts_at)
);

CREATE TABLE logistics.collection (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id           uuid NOT NULL REFERENCES settlement.invoice (id),
  method               text NOT NULL CHECK (method IN ('pickup', 'delivery', 'towing')),
  slot_id              uuid REFERENCES logistics.collection_slot (id),
  delivery_address     jsonb,
  qr_token_hmac        bytea UNIQUE,             -- the QR pass; only the hash is stored
  status               text NOT NULL DEFAULT 'awaiting_payment'
                         CHECK (status IN ('awaiting_payment', 'ready', 'scheduled', 'released',
                                           'delivered', 'expired', 'cancelled')),
  storage_clock_from   timestamptz,              -- shown on the invoice (blueprint module 10)
  released_at          timestamptz,
  released_by          uuid REFERENCES identity.account (id),
  CHECK (method = 'pickup' OR delivery_address IS NOT NULL),
  CHECK (status NOT IN ('released', 'delivered') OR (released_at IS NOT NULL AND released_by IS NOT NULL))
);

CREATE TABLE logistics.collection_lot (
  collection_id uuid NOT NULL REFERENCES logistics.collection (id),
  lot_id        uuid NOT NULL REFERENCES catalogue.lot (id),
  PRIMARY KEY (collection_id, lot_id)
);

-- Goods leave only against a paid invoice. Vehicle title is enforced on the lot itself.
CREATE FUNCTION logistics.guard_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('ready', 'scheduled', 'released', 'delivered')
     AND NOT EXISTS (SELECT 1 FROM settlement.invoice i WHERE i.id = NEW.invoice_id AND i.status = 'paid') THEN
    RAISE EXCEPTION 'collection %: invoice is not paid', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER collection_release_guard BEFORE INSERT OR UPDATE OF status ON logistics.collection
  FOR EACH ROW EXECUTE FUNCTION logistics.guard_release();
CREATE TRIGGER collection_audit AFTER INSERT OR UPDATE ON logistics.collection
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

CREATE TABLE logistics.title_case (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id           uuid NOT NULL UNIQUE REFERENCES catalogue.lot (id),
  buyer_account_id uuid NOT NULL REFERENCES identity.account (id),
  status           text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'in_progress', 'complete', 'blocked', 'cancelled')),
  opened_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at      timestamptz NOT NULL,
  completed_at     timestamptz,
  CHECK ((status = 'complete') = (completed_at IS NOT NULL))
);

CREATE TABLE logistics.title_step (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_case_id       uuid NOT NULL REFERENCES logistics.title_case (id),
  step                text NOT NULL CHECK (step IN ('zrp_clearance', 'zimra_clearance', 'cvr_change_of_ownership')),
  sort                smallint NOT NULL,
  owner_party         text NOT NULL CHECK (owner_party IN ('abc', 'buyer', 'seller', 'agency')),
  owner_staff_id      uuid REFERENCES identity.account (id),
  due_at              timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'rejected')),
  evidence_object_key text,
  completed_by        uuid REFERENCES identity.account (id),
  completed_at        timestamptz,
  UNIQUE (title_case_id, step),
  CHECK (status <> 'done' OR (evidence_object_key IS NOT NULL AND completed_by IS NOT NULL AND completed_at IS NOT NULL))
);

-- Title steps happen in order: police clearance, then ZIMRA, then change of ownership.
CREATE FUNCTION logistics.guard_title_step_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'done' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'done') AND EXISTS (
       SELECT 1 FROM logistics.title_step
        WHERE title_case_id = NEW.title_case_id AND sort < NEW.sort AND status <> 'done') THEN
    RAISE EXCEPTION 'title step % cannot be done before the earlier steps', NEW.step USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER title_step_order BEFORE INSERT OR UPDATE OF status ON logistics.title_step
  FOR EACH ROW EXECUTE FUNCTION logistics.guard_title_step_order();
CREATE TRIGGER title_step_audit AFTER INSERT OR UPDATE ON logistics.title_step
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

-- A title case completes only when it has all three steps and every one is done.
CREATE FUNCTION logistics.guard_title_case() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'complete' AND OLD.status IS DISTINCT FROM 'complete' THEN
    IF (SELECT count(*) FROM logistics.title_step
         WHERE title_case_id = NEW.id AND status = 'done') < 3 THEN
      RAISE EXCEPTION 'title case %: ZRP, ZIMRA and CVR steps must all be done', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER title_case_guard BEFORE UPDATE OF status ON logistics.title_case
  FOR EACH ROW EXECUTE FUNCTION logistics.guard_title_case();
CREATE TRIGGER title_case_audit AFTER INSERT OR UPDATE ON logistics.title_case
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

-- -----------------------------------------------------------------------------
-- payout: seller payout destinations, payouts and statement lines
-- -----------------------------------------------------------------------------

CREATE TABLE payout.destination (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES identity.account (id),
  method             text NOT NULL CHECK (method IN ('bank_transfer', 'ecocash', 'onemoney', 'innbucks',
                                                     'omari', 'zimswitch')),
  currency           core.currency_code NOT NULL,
  details_enc        bytea NOT NULL,
  details_hmac       bytea NOT NULL,             -- also written to identity.link_signal
  active             boolean NOT NULL DEFAULT true,
  verified_at        timestamptz,
  cooling_off_until  timestamptz NOT NULL,       -- no payout to a new destination before this
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, currency)
);

CREATE TRIGGER destination_audit AFTER INSERT OR UPDATE ON payout.destination
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('active');

CREATE TABLE payout.payout (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_account_id uuid NOT NULL REFERENCES identity.account (id),
  currency          core.currency_code NOT NULL,
  status            text NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled', 'approved', 'processing', 'paid', 'failed', 'held', 'cancelled')),
  due_date          date NOT NULL,
  gross_minor       bigint NOT NULL CHECK (gross_minor >= 0),
  deductions_minor  bigint NOT NULL CHECK (deductions_minor >= 0),
  net_minor         bigint NOT NULL CHECK (net_minor >= 0),
  destination_id    uuid,
  gateway           text,
  gateway_reference text,
  journal_id        uuid UNIQUE,
  approved_by       uuid REFERENCES identity.account (id),
  paid_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (destination_id, currency) REFERENCES payout.destination (id, currency),
  FOREIGN KEY (journal_id, currency) REFERENCES ledger.journal (id, currency),
  UNIQUE (gateway, gateway_reference),
  CHECK (net_minor = gross_minor - deductions_minor),
  CHECK (status NOT IN ('approved', 'processing', 'paid') OR destination_id IS NOT NULL),
  CHECK (status <> 'paid' OR (journal_id IS NOT NULL AND paid_at IS NOT NULL))
);

CREATE TRIGGER payout_audit AFTER INSERT OR UPDATE ON payout.payout
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

CREATE TABLE payout.payout_line (
  id           bigserial PRIMARY KEY,
  payout_id    uuid NOT NULL REFERENCES payout.payout (id),
  lot_id       uuid REFERENCES catalogue.lot (id),
  invoice_id   uuid REFERENCES settlement.invoice (id),
  line_type    text NOT NULL CHECK (line_type IN ('hammer', 'commission', 'seller_fee', 'collection_charge',
                                                  'advance_recovery', 'adjustment')),
  description  text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),  -- + proceeds, - deductions
  CHECK (line_type <> 'hammer' OR amount_minor > 0),
  CHECK (line_type NOT IN ('commission', 'seller_fee', 'collection_charge', 'advance_recovery') OR amount_minor < 0)
);
CREATE INDEX payout_line_payout_idx ON payout.payout_line (payout_id);

CREATE TRIGGER payout_line_append_only BEFORE UPDATE OR DELETE ON payout.payout_line
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- A payout's gross and deductions must equal its lines, checked at commit.
CREATE FUNCTION payout.check_payout_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_payout uuid;
  v_gross  bigint;
  v_ded    bigint;
  v_lgross numeric;
  v_lded   numeric;
BEGIN
  v_payout := coalesce(to_jsonb(NEW) ->> 'payout_id', to_jsonb(NEW) ->> 'id')::uuid;
  SELECT gross_minor, deductions_minor INTO v_gross, v_ded FROM payout.payout WHERE id = v_payout;
  SELECT coalesce(sum(amount_minor) FILTER (WHERE amount_minor > 0), 0),
         coalesce(-sum(amount_minor) FILTER (WHERE amount_minor < 0), 0)
    INTO v_lgross, v_lded
    FROM payout.payout_line WHERE payout_id = v_payout;
  IF v_lgross <> v_gross OR v_lded <> v_ded THEN
    RAISE EXCEPTION 'payout %: header (gross %, deductions %) does not match lines (gross %, deductions %)',
      v_payout, v_gross, v_ded, v_lgross, v_lded USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER payout_matches_lines AFTER INSERT OR UPDATE OF gross_minor, deductions_minor ON payout.payout
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payout.check_payout_lines();
CREATE CONSTRAINT TRIGGER payout_line_matches AFTER INSERT ON payout.payout_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payout.check_payout_lines();

-- -----------------------------------------------------------------------------
-- support: disputes (tickets are specified in deliverable 17)
-- -----------------------------------------------------------------------------

CREATE TABLE support.dispute (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id            uuid NOT NULL REFERENCES catalogue.lot (id),
  invoice_id        uuid NOT NULL REFERENCES settlement.invoice (id),
  raised_by         uuid NOT NULL REFERENCES identity.account (id),
  category          text NOT NULL CHECK (category IN ('not_as_described', 'missing', 'damaged_in_custody',
                                                      'inspection_inaccuracy', 'other')),
  listed_condition  text NOT NULL REFERENCES catalogue.condition_term (code),
  claimed_condition text REFERENCES catalogue.condition_term (code),
  description       text NOT NULL,
  status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'under_review', 'upheld', 'partially_upheld', 'rejected', 'withdrawn')),
  owner_staff_id    uuid REFERENCES identity.account (id),
  response_due_at   timestamptz NOT NULL,
  remedy            text CHECK (remedy IN ('none', 'partial_refund', 'full_refund_and_return', 'repair_or_replace')),
  refund_minor      bigint CHECK (refund_minor IS NULL OR refund_minor > 0),
  decision          text,
  decided_by        uuid REFERENCES identity.account (id),
  decided_at        timestamptz,
  raised_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status NOT IN ('upheld', 'partially_upheld', 'rejected')
         OR (decision IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND remedy IS NOT NULL)),
  CHECK (remedy NOT IN ('partial_refund', 'full_refund_and_return') OR refund_minor IS NOT NULL)
);

CREATE TRIGGER dispute_audit AFTER INSERT OR UPDATE ON support.dispute
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

CREATE TABLE support.dispute_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  uuid NOT NULL REFERENCES support.dispute (id),
  kind        text NOT NULL CHECK (kind IN ('photo', 'video', 'document')),
  object_key  text NOT NULL UNIQUE,
  uploaded_by uuid NOT NULL REFERENCES identity.account (id),
  uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER dispute_evidence_append_only BEFORE UPDATE OR DELETE ON support.dispute_evidence
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- -----------------------------------------------------------------------------
-- comms: one template library, messages with delivery status, preferences
-- -----------------------------------------------------------------------------

CREATE TABLE comms.template (
  key                    text NOT NULL,          -- 'outbid', 'ending_soon', 'won', 'invoice', ...
  version                integer NOT NULL CHECK (version > 0),
  channel                text NOT NULL CHECK (channel IN ('whatsapp', 'push', 'sms', 'email', 'in_app')),
  locale                 text NOT NULL DEFAULT 'en-ZW',
  category               text NOT NULL CHECK (category IN ('transactional', 'alert', 'marketing')),
  body                   text NOT NULL,          -- or provider template body with placeholders
  provider_template_name text,                   -- WhatsApp approved template name
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  PRIMARY KEY (key, version, channel, locale)
);

CREATE TABLE comms.message (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_key          text NOT NULL,            -- business event, e.g. 'outbid:<bid id>'
  recipient_account_id uuid NOT NULL REFERENCES identity.account (id),
  channel              text NOT NULL CHECK (channel IN ('whatsapp', 'push', 'sms', 'email', 'in_app')),
  template_key         text NOT NULL,
  template_version     integer NOT NULL,
  locale               text NOT NULL,
  params               jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'suppressed')),
  provider             text,
  provider_message_id  text,
  fallback_of          uuid REFERENCES comms.message (id),
  queued_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at              timestamptz,
  delivered_at         timestamptz,
  failure_reason       text,
  FOREIGN KEY (template_key, template_version, channel, locale)
    REFERENCES comms.template (key, version, channel, locale),
  UNIQUE (message_key, channel, recipient_account_id)   -- R4
);
CREATE INDEX message_recipient_idx ON comms.message (recipient_account_id, queued_at);

CREATE TABLE comms.preference (
  account_id uuid NOT NULL REFERENCES identity.account (id),
  category   text NOT NULL,                      -- 'outbid', 'ending_soon', 'saved_search', 'marketing', ...
  channel    text NOT NULL CHECK (channel IN ('whatsapp', 'push', 'sms', 'email')),
  enabled    boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, category, channel)
);

-- -----------------------------------------------------------------------------
-- Public read models
-- -----------------------------------------------------------------------------

-- Past realised prices (blueprint module 4: "Past realised prices public").
CREATE VIEW catalogue.v_realised_price AS
SELECT l.lot_ref, l.title, l.category_code, l.item_state, l.condition, l.location_branch,
       al.currency, al.hammer_minor, al.closed_at, a.code AS auction_code
  FROM auction.auction_lot al
  JOIN catalogue.lot l    ON l.id = al.lot_id
  JOIN auction.auction a  ON a.id = al.auction_id
 WHERE al.result = 'sold';

-- -----------------------------------------------------------------------------
-- analytics: blueprint §9 measures as read-only functions, and the frozen baseline
-- -----------------------------------------------------------------------------

-- Analytics reads the replica: every measure is a STABLE SQL function over domain
-- tables and the outbox, so it never writes. Periods are half-open [p_from, p_to).
-- p_branch NULL means every branch. Money is never summed across currencies.
-- The first measurement, frozen (blueprint §9: "the first task is a baseline").
CREATE TABLE analytics.baseline_snapshot (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label       text NOT NULL UNIQUE,
  period_from timestamptz NOT NULL,
  period_to   timestamptz NOT NULL,
  branch_code text REFERENCES core.branch (code),
  measures    jsonb NOT NULL,
  frozen_by   uuid NOT NULL REFERENCES identity.account (id),
  frozen_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  notes       text,
  CHECK (period_to > period_from)
);

CREATE TRIGGER baseline_snapshot_append_only BEFORE UPDATE OR DELETE ON analytics.baseline_snapshot
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- Time from joining an auction to the first bid in it (blueprint gap 3: approval took hours).
CREATE FUNCTION analytics.registration_to_first_bid(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL)
RETURNS TABLE (registrations bigint, with_first_bid bigint, median_seconds numeric, p90_seconds numeric)
LANGUAGE sql STABLE AS $$
  WITH r AS (
    SELECT reg.created_at,
           (SELECT min(b.server_received_at) FROM bidding.bid b
             WHERE b.registration_id = reg.id AND b.origin = 'bidder' AND b.outcome_at_placement <> 'rejected') AS first_bid_at
      FROM registration.registration reg
      JOIN auction.auction a ON a.id = reg.auction_id
     WHERE reg.created_at >= p_from AND reg.created_at < p_to
       AND (p_branch IS NULL OR a.branch_code = p_branch))
  SELECT count(*), count(first_bid_at),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_bid_at - created_at)::float8)::numeric, 0),
         round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM first_bid_at - created_at)::float8)::numeric, 0)
    FROM r
$$;

-- Deposits (wallet top-ups) and winnings (invoice payments) paid in the app rather than at a counter.
-- Top-ups belong to no branch, so the branch filter narrows winnings only.
CREATE FUNCTION analytics.in_app_payment_share(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL)
RETURNS TABLE (currency text, deposits bigint, deposits_in_app bigint, deposits_minor bigint, deposits_in_app_minor bigint,
               winnings bigint, winnings_in_app bigint, winnings_minor bigint, winnings_in_app_minor bigint)
LANGUAGE sql STABLE AS $$
  WITH d AS (
    SELECT p.currency::text AS currency, count(*) AS n, count(*) FILTER (WHERE p.method <> 'branch_cash') AS n_app,
           sum(p.amount_minor)::bigint AS amt,
           coalesce(sum(p.amount_minor) FILTER (WHERE p.method <> 'branch_cash'), 0)::bigint AS amt_app
      FROM payment.payment p
     WHERE p.purpose = 'top_up' AND p.status = 'succeeded' AND p.confirmed_at >= p_from AND p.confirmed_at < p_to
     GROUP BY 1),
  w AS (
    SELECT p.currency::text AS currency, count(*) AS n, count(*) FILTER (WHERE p.method <> 'branch_cash') AS n_app,
           sum(p.amount_minor)::bigint AS amt,
           coalesce(sum(p.amount_minor) FILTER (WHERE p.method <> 'branch_cash'), 0)::bigint AS amt_app
      FROM payment.payment p
      JOIN settlement.invoice i ON i.id = p.invoice_id
      JOIN auction.auction a ON a.id = i.auction_id
     WHERE p.purpose = 'invoice' AND p.status = 'succeeded' AND p.confirmed_at >= p_from AND p.confirmed_at < p_to
       AND (p_branch IS NULL OR a.branch_code = p_branch)
     GROUP BY 1)
  SELECT coalesce(d.currency, w.currency),
         coalesce(d.n, 0), coalesce(d.n_app, 0), coalesce(d.amt, 0), coalesce(d.amt_app, 0),
         coalesce(w.n, 0), coalesce(w.n_app, 0), coalesce(w.amt, 0), coalesce(w.amt_app, 0)
    FROM d FULL JOIN w ON w.currency = d.currency
   ORDER BY 1
$$;

-- Time from the hammer to the invoice being paid, for invoices whose hammer fell in the period.
CREATE FUNCTION analytics.hammer_to_payment(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL)
RETURNS TABLE (invoices bigint, paid bigint, median_seconds numeric, p90_seconds numeric)
LANGUAGE sql STABLE AS $$
  WITH inv AS (
    SELECT i.id, i.paid_at, max(al.closed_at) AS hammer_at
      FROM settlement.invoice i
      JOIN settlement.invoice_line il ON il.invoice_id = i.id AND il.line_type = 'hammer'
      JOIN auction.auction_lot al ON al.id = il.auction_lot_id
      JOIN auction.auction a ON a.id = i.auction_id
     WHERE p_branch IS NULL OR a.branch_code = p_branch
     GROUP BY i.id, i.paid_at
    HAVING max(al.closed_at) >= p_from AND max(al.closed_at) < p_to)
  SELECT count(*), count(paid_at),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM paid_at - hammer_at)::float8)::numeric, 0),
         round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM paid_at - hammer_at)::float8)::numeric, 0)
    FROM inv
$$;

-- Lots that closed in the period, by category: sold out of offered (withdrawn lots are not counted as offered).
CREATE FUNCTION analytics.sell_through_by_category(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL)
RETURNS TABLE (category_code text, offered bigint, sold bigint, sell_through numeric)
LANGUAGE sql STABLE AS $$
  SELECT l.category_code, count(*), count(*) FILTER (WHERE al.result = 'sold'),
         round(count(*) FILTER (WHERE al.result = 'sold')::numeric / count(*), 4)
    FROM auction.auction_lot al
    JOIN catalogue.lot l ON l.id = al.lot_id
    JOIN auction.auction a ON a.id = al.auction_id
   WHERE al.result IN ('sold', 'unsold', 'reserve_not_met')
     AND al.closed_at >= p_from AND al.closed_at < p_to
     AND (p_branch IS NULL OR a.branch_code = p_branch)
   GROUP BY l.category_code
   ORDER BY l.category_code
$$;

-- Of invoices issued in the period: how many went overdue, how many defaulted (deposit forfeit stage),
-- how many overdue ones were paid in the end, and how many defaulted lots later sold and were paid for.
CREATE FUNCTION analytics.default_and_recovery(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL)
RETURNS TABLE (invoices bigint, overdue bigint, defaulted bigint, cured bigint, defaulted_lots bigint, recovered_lots bigint,
               default_rate numeric, cure_rate numeric, recovery_rate numeric)
LANGUAGE sql STABLE AS $$
  WITH inv AS (
    SELECT i.id, i.status, i.issued_at, (dc.id IS NOT NULL) AS went_overdue
      FROM settlement.invoice i
      JOIN auction.auction a ON a.id = i.auction_id
      LEFT JOIN settlement.default_case dc ON dc.invoice_id = i.id
     WHERE i.issued_at >= p_from AND i.issued_at < p_to
       AND (p_branch IS NULL OR a.branch_code = p_branch)),
  dl AS (
    SELECT DISTINCT il.lot_id, inv.issued_at
      FROM inv JOIN settlement.invoice_line il ON il.invoice_id = inv.id AND il.line_type = 'hammer'
     WHERE inv.status = 'defaulted'),
  rec AS (
    SELECT dl.lot_id FROM dl
     WHERE EXISTS (SELECT 1 FROM auction.auction_lot al2
                     JOIN settlement.invoice_line il2 ON il2.auction_lot_id = al2.id AND il2.line_type = 'hammer'
                     JOIN settlement.invoice i2 ON i2.id = il2.invoice_id AND i2.status = 'paid'
                    WHERE al2.lot_id = dl.lot_id AND al2.result = 'sold' AND al2.closed_at > dl.issued_at)),
  c AS (
    SELECT count(*) AS invoices,
           count(*) FILTER (WHERE went_overdue) AS overdue,
           count(*) FILTER (WHERE status = 'defaulted') AS defaulted,
           count(*) FILTER (WHERE went_overdue AND status = 'paid') AS cured
      FROM inv)
  SELECT c.invoices, c.overdue, c.defaulted, c.cured,
         (SELECT count(*) FROM dl), (SELECT count(*) FROM rec),
         round(c.defaulted::numeric / nullif(c.invoices, 0), 4),
         round(c.cured::numeric / nullif(c.overdue, 0), 4),
         round((SELECT count(*) FROM rec)::numeric / nullif((SELECT count(*) FROM dl), 0), 4)
    FROM c
$$;

-- Accepted bids (proxy bids included, voided bids excluded) and unique bidders per lot closed in the period.
CREATE FUNCTION analytics.bids_per_lot(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL)
RETURNS TABLE (lots bigint, lots_with_bids bigint, bids bigint, bidder_bids bigint, avg_bids numeric, median_bids numeric,
               avg_unique_bidders numeric, median_unique_bidders numeric)
LANGUAGE sql STABLE AS $$
  WITH per AS (
    SELECT al.id,
           count(b.id) AS bids,
           count(b.id) FILTER (WHERE b.origin = 'bidder') AS bidder_bids,
           count(DISTINCT b.account_id) AS bidders
      FROM auction.auction_lot al
      JOIN auction.auction a ON a.id = al.auction_id
      LEFT JOIN bidding.bid b ON b.auction_lot_id = al.id AND b.outcome_at_placement <> 'rejected'
                             AND NOT EXISTS (SELECT 1 FROM bidding.bid_void v WHERE v.bid_id = b.id)
     WHERE al.result IN ('sold', 'unsold', 'reserve_not_met')
       AND al.closed_at >= p_from AND al.closed_at < p_to
       AND (p_branch IS NULL OR a.branch_code = p_branch)
     GROUP BY al.id)
  SELECT count(*), count(*) FILTER (WHERE bids > 0), coalesce(sum(bids), 0)::bigint, coalesce(sum(bidder_bids), 0)::bigint,
         round(avg(bids), 2), round(percentile_cont(0.5) WITHIN GROUP (ORDER BY bids)::numeric, 1),
         round(avg(bidders), 2), round(percentile_cont(0.5) WITHIN GROUP (ORDER BY bidders)::numeric, 1)
    FROM per
$$;

-- Vehicle lots offered in auctions that opened in the period, with a published inspection report.
CREATE FUNCTION analytics.inspection_coverage(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL)
RETURNS TABLE (vehicle_lots bigint, with_report bigint, share numeric)
LANGUAGE sql STABLE AS $$
  WITH v AS (
    SELECT al.id,
           EXISTS (SELECT 1 FROM catalogue.inspection_report ir
                    WHERE ir.lot_id = al.lot_id AND ir.published_at IS NOT NULL
                      AND ir.published_at <= coalesce(al.closed_at, clock_timestamp())) AS has_report
      FROM auction.auction_lot al
      JOIN auction.auction a ON a.id = al.auction_id
      JOIN catalogue.lot l ON l.id = al.lot_id
     WHERE l.is_vehicle AND a.status NOT IN ('draft', 'cancelled')
       AND a.opens_at >= p_from AND a.opens_at < p_to
       AND (p_branch IS NULL OR a.branch_code = p_branch))
  SELECT count(*), count(*) FILTER (WHERE has_report), round(count(*) FILTER (WHERE has_report)::numeric / nullif(count(*), 0), 4)
    FROM v
$$;

-- Time from the hammer to the seller being paid, for lots sold in the period.
CREATE FUNCTION analytics.sale_to_payout(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL)
RETURNS TABLE (sold_lots bigint, paid_out bigint, median_seconds numeric, p90_seconds numeric)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT al.closed_at,
           (SELECT min(p.paid_at) FROM payout.payout_line pl JOIN payout.payout p ON p.id = pl.payout_id
             WHERE pl.lot_id = al.lot_id AND pl.line_type = 'hammer' AND p.status = 'paid' AND p.paid_at >= al.closed_at) AS paid_at
      FROM auction.auction_lot al
      JOIN auction.auction a ON a.id = al.auction_id
     WHERE al.result = 'sold' AND al.closed_at >= p_from AND al.closed_at < p_to
       AND (p_branch IS NULL OR a.branch_code = p_branch))
  SELECT count(*), count(paid_at),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM paid_at - closed_at)::float8)::numeric, 0),
         round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM paid_at - closed_at)::float8)::numeric, 0)
    FROM s
$$;

-- Support tickets per 100 sales and time to first reply, from the support module's outbox events
-- (ticket.opened, ticket.first_reply). Until the support module emits them, instrumented is false
-- and the ticket figures are NULL rather than a misleading zero.
CREATE FUNCTION analytics.support_measures(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL)
RETURNS TABLE (instrumented boolean, tickets bigint, sales bigint, tickets_per_100_sales numeric, replied bigint,
               median_first_reply_seconds numeric, p90_first_reply_seconds numeric)
LANGUAGE sql STABLE AS $$
  WITH inst AS (
    SELECT EXISTS (SELECT 1 FROM core.outbox WHERE topic IN ('ticket.opened', 'ticket.first_reply')) AS on_),
  t AS (
    SELECT o.aggregate_id, min(o.created_at) AS opened_at
      FROM core.outbox o
     WHERE o.topic = 'ticket.opened' AND o.created_at >= p_from AND o.created_at < p_to
       AND (p_branch IS NULL OR o.payload ->> 'branch' = p_branch)
     GROUP BY o.aggregate_id),
  r AS (
    SELECT t.opened_at, (SELECT min(o.created_at) FROM core.outbox o
                          WHERE o.topic = 'ticket.first_reply' AND o.aggregate_id = t.aggregate_id) AS replied_at
      FROM t),
  s AS (
    SELECT count(*) AS n FROM auction.auction_lot al JOIN auction.auction a ON a.id = al.auction_id
     WHERE al.result = 'sold' AND al.closed_at >= p_from AND al.closed_at < p_to
       AND (p_branch IS NULL OR a.branch_code = p_branch)),
  agg AS (
    SELECT count(*) AS tickets, count(replied_at) AS replied,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM replied_at - opened_at)::float8) AS p50,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM replied_at - opened_at)::float8) AS p90
      FROM r)
  SELECT inst.on_,
         CASE WHEN inst.on_ THEN agg.tickets END,
         s.n,
         CASE WHEN inst.on_ AND s.n > 0 THEN round(agg.tickets * 100.0 / s.n, 2) END,
         CASE WHEN inst.on_ THEN agg.replied END,
         CASE WHEN inst.on_ THEN round(agg.p50::numeric, 0) END,
         CASE WHEN inst.on_ THEN round(agg.p90::numeric, 0) END
    FROM inst, s, agg
$$;

-- Realised hammer prices by category and currency for lots sold in the period.
CREATE FUNCTION analytics.realised_prices(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL)
RETURNS TABLE (category_code text, currency text, lots_sold bigint, median_hammer_minor bigint, min_hammer_minor bigint,
               max_hammer_minor bigint, total_hammer_minor bigint)
LANGUAGE sql STABLE AS $$
  SELECT l.category_code, al.currency::text, count(*),
         percentile_disc(0.5) WITHIN GROUP (ORDER BY al.hammer_minor), min(al.hammer_minor), max(al.hammer_minor),
         sum(al.hammer_minor)::bigint
    FROM auction.auction_lot al
    JOIN catalogue.lot l ON l.id = al.lot_id
    JOIN auction.auction a ON a.id = al.auction_id
   WHERE al.result = 'sold' AND al.closed_at >= p_from AND al.closed_at < p_to
     AND (p_branch IS NULL OR a.branch_code = p_branch)
   GROUP BY l.category_code, al.currency
   ORDER BY l.category_code, al.currency
$$;

-- ABC's revenue per currency from the ledger (income accounts, net of reversals), the write-off cost,
-- and the gross hammer of lots sold. USD and ZiG are separate rows and never added together.
CREATE FUNCTION analytics.revenue_by_currency(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL)
RETURNS TABLE (currency text, revenue_type text, amount_minor bigint)
LANGUAGE sql STABLE AS $$
  WITH j AS (
    SELECT j.id,
           CASE j.reference_type
             WHEN 'invoice' THEN (SELECT a.branch_code FROM settlement.invoice i JOIN auction.auction a ON a.id = i.auction_id
                                   WHERE i.id::text = j.reference_id)
             WHEN 'hold' THEN (SELECT a.branch_code FROM ledger.hold h
                                 JOIN registration.registration reg ON h.reference_type = 'registration' AND reg.id::text = h.reference_id
                                 JOIN auction.auction a ON a.id = reg.auction_id
                                WHERE h.id::text = j.reference_id)
           END AS branch_code
      FROM ledger.journal j
     WHERE j.created_at >= p_from AND j.created_at < p_to),
  lines AS (
    SELECT p.currency::text AS currency,
           CASE WHEN ba.purpose = 'write_off' THEN 'write_off_expense'
                ELSE ba.purpose || CASE WHEN ba.sub_code <> '' THEN ':' || ba.sub_code ELSE '' END END AS revenue_type,
           -sum(p.amount_minor)::bigint AS amount_minor
      FROM ledger.posting p
      JOIN ledger.book_account ba ON ba.id = p.book_account_id
      JOIN j ON j.id = p.journal_id
     WHERE ba.owner_type = 'platform'
       AND ba.purpose IN ('commission_income', 'fee_income', 'delivery_income', 'forfeiture_income', 'write_off')
       AND (p_branch IS NULL OR j.branch_code = p_branch)
     GROUP BY 1, 2),
  gmv AS (
    SELECT al.currency::text AS currency, 'gross_hammer'::text AS revenue_type, sum(al.hammer_minor)::bigint AS amount_minor
      FROM auction.auction_lot al JOIN auction.auction a ON a.id = al.auction_id
     WHERE al.result = 'sold' AND al.closed_at >= p_from AND al.closed_at < p_to
       AND (p_branch IS NULL OR a.branch_code = p_branch)
     GROUP BY 1)
  SELECT * FROM lines UNION ALL SELECT * FROM gmv
   ORDER BY 1, 2
$$;

-- Gateway payment outcomes in the period. Gateway payments belong to no branch, so p_branch is not used.
CREATE FUNCTION analytics.gateway_success(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL)
RETURNS TABLE (gateway text, method text, currency text, attempts bigint, succeeded bigint, failed bigint, expired bigint,
               cancelled bigint, pending bigint, success_rate numeric)
LANGUAGE sql STABLE AS $$
  SELECT p.gateway, p.method, p.currency::text, count(*),
         count(*) FILTER (WHERE p.status IN ('succeeded', 'reversed')),
         count(*) FILTER (WHERE p.status = 'failed'),
         count(*) FILTER (WHERE p.status = 'expired'),
         count(*) FILTER (WHERE p.status = 'cancelled'),
         count(*) FILTER (WHERE p.status IN ('initiated', 'pending')),
         round(count(*) FILTER (WHERE p.status IN ('succeeded', 'reversed'))::numeric
               / nullif(count(*) FILTER (WHERE p.status NOT IN ('initiated', 'pending')), 0), 4)
    FROM payment.payment p
   WHERE p.gateway NOT IN ('internal', 'branch')
     AND p.created_at >= p_from AND p.created_at < p_to
   GROUP BY p.gateway, p.method, p.currency
   ORDER BY 1, 2, 3
$$;

COMMIT;
