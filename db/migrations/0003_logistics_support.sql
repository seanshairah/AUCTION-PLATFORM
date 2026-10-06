-- Logistics (deliverable 15) and support and disputes (deliverable 17).
-- Folded into db/schema.sql as well; this file brings existing databases up to date.
-- Design: docs/15-logistics.md, docs/17-support-disputes.md.

-- Ledger: three journal kinds for the new money movements (R1).
ALTER TABLE ledger.journal DROP CONSTRAINT journal_kind_check;
ALTER TABLE ledger.journal ADD CONSTRAINT journal_kind_check CHECK (kind IN (
  'top_up', 'branch_cash', 'hold', 'hold_release', 'invoice_issued',
  'invoice_payment', 'invoice_credit', 'refund', 'forfeit', 'relist_fee',
  'commission', 'payout', 'gateway_settlement', 'reversal', 'adjustment',
  'storage_fee', 'delivery_charge', 'clawback'));

-- Lot states: a claim upheld inside the claim window can return a lot whose seller was already paid (A54).
UPDATE catalogue.lot_state
   SET is_terminal = false,
       description = 'Seller paid; lot complete unless a claim made inside the claim window is upheld (refunded)'
 WHERE code = 'paid_out';
INSERT INTO catalogue.lot_state_transition (from_state, to_state) VALUES ('paid_out', 'refunded');

-- -----------------------------------------------------------------------------
-- logistics: slot bookings, storage charges, deliveries
-- -----------------------------------------------------------------------------

CREATE INDEX collection_invoice_idx ON logistics.collection (invoice_id);
CREATE INDEX collection_slot_branch_idx ON logistics.collection_slot (branch_code, starts_at);

CREATE TABLE logistics.slot_booking (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES logistics.collection (id),
  slot_id       uuid NOT NULL REFERENCES logistics.collection_slot (id),
  account_id    uuid NOT NULL REFERENCES identity.account (id),
  status        text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled', 'attended', 'no_show')),
  client_key    text,
  booked_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_at  timestamptz,
  UNIQUE (account_id, client_key),                -- R4: a retried booking returns the first one
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
-- One live booking per collection: rebooking cancels the old one in the same transaction.
CREATE UNIQUE INDEX slot_booking_live_idx ON logistics.slot_booking (collection_id) WHERE status = 'booked';
CREATE INDEX slot_booking_slot_idx ON logistics.slot_booking (slot_id) WHERE status = 'booked';

-- A collection slot never holds more live bookings than its capacity (checked under a row lock on the slot).
CREATE FUNCTION logistics.guard_slot_capacity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_capacity integer;
  v_booked   integer;
BEGIN
  IF NEW.status <> 'booked' THEN
    RETURN NEW;
  END IF;
  SELECT capacity INTO v_capacity FROM logistics.collection_slot WHERE id = NEW.slot_id FOR UPDATE;
  SELECT count(*) INTO v_booked FROM logistics.slot_booking
   WHERE slot_id = NEW.slot_id AND status = 'booked' AND id <> NEW.id;
  IF v_booked >= v_capacity THEN
    RAISE EXCEPTION 'collection slot % is full', NEW.slot_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER slot_booking_capacity BEFORE INSERT OR UPDATE OF status ON logistics.slot_booking
  FOR EACH ROW EXECUTE FUNCTION logistics.guard_slot_capacity();
CREATE TRIGGER slot_booking_audit AFTER INSERT OR UPDATE ON logistics.slot_booking
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

-- Storage charged once per collection, at release, from the buyer's wallet (A51).
CREATE TABLE logistics.storage_charge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL UNIQUE REFERENCES logistics.collection (id),
  currency      core.currency_code NOT NULL,
  days          integer NOT NULL CHECK (days > 0),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  journal_id    uuid NOT NULL,
  charged_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (journal_id, currency) REFERENCES ledger.journal (id, currency)
);

CREATE TRIGGER storage_charge_append_only BEFORE UPDATE OR DELETE ON logistics.storage_charge
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- Door delivery of non-vehicle lots by a courier partner, charged from the wallet at booking.
CREATE TABLE logistics.delivery (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id    uuid NOT NULL REFERENCES logistics.collection (id),
  partner_id       uuid NOT NULL REFERENCES logistics.partner (id),
  account_id       uuid NOT NULL REFERENCES identity.account (id),
  town             text NOT NULL,
  size_class       text NOT NULL CHECK (size_class IN ('small', 'medium', 'large')),
  address          jsonb NOT NULL,
  currency         core.currency_code NOT NULL,
  charge_minor     bigint NOT NULL CHECK (charge_minor > 0),
  quote_lines      jsonb NOT NULL,                -- the quoteLot delivery lines charged (R2)
  rule_version_id  uuid NOT NULL REFERENCES rulebook.rule_set_version (id),
  charge_journal_id uuid NOT NULL,
  refund_journal_id uuid,
  status           text NOT NULL DEFAULT 'booked'
                     CHECK (status IN ('booked', 'collected', 'in_transit', 'delivered', 'failed', 'cancelled')),
  proof_object_key text,
  client_key       text NOT NULL,
  booked_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at     timestamptz,
  FOREIGN KEY (charge_journal_id, currency) REFERENCES ledger.journal (id, currency),
  FOREIGN KEY (refund_journal_id, currency) REFERENCES ledger.journal (id, currency),
  UNIQUE (account_id, client_key),                -- R4
  CHECK (status <> 'delivered' OR (proof_object_key IS NOT NULL AND delivered_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR refund_journal_id IS NOT NULL)
);
CREATE UNIQUE INDEX delivery_live_idx ON logistics.delivery (collection_id) WHERE status NOT IN ('cancelled', 'failed');

-- Couriers must be couriers: vehicles are towed, not delivered (CONFIRMED).
CREATE FUNCTION logistics.guard_delivery_partner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM logistics.partner WHERE id = NEW.partner_id AND kind = 'courier') THEN
    RAISE EXCEPTION 'delivery %: partner is not a courier', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM logistics.collection_lot cl JOIN catalogue.lot l ON l.id = cl.lot_id
              WHERE cl.collection_id = NEW.collection_id AND l.is_vehicle) THEN
    RAISE EXCEPTION 'delivery %: vehicles are not delivered', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER delivery_partner_guard BEFORE INSERT ON logistics.delivery
  FOR EACH ROW EXECUTE FUNCTION logistics.guard_delivery_partner();
CREATE TRIGGER delivery_audit AFTER INSERT OR UPDATE ON logistics.delivery
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

-- Every status update with its proof, append-only.
CREATE TABLE logistics.delivery_event (
  id               bigserial PRIMARY KEY,
  delivery_id      uuid NOT NULL REFERENCES logistics.delivery (id),
  status           text NOT NULL CHECK (status IN ('booked', 'collected', 'in_transit', 'delivered', 'failed', 'cancelled')),
  note             text,
  proof_object_key text,
  recorded_by      uuid NOT NULL REFERENCES identity.account (id),
  recorded_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX delivery_event_delivery_idx ON logistics.delivery_event (delivery_id, id);

CREATE TRIGGER delivery_event_append_only BEFORE UPDATE OR DELETE ON logistics.delivery_event
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- -----------------------------------------------------------------------------
-- support: dispute decisions, tickets
-- -----------------------------------------------------------------------------

ALTER TABLE support.dispute
  ADD COLUMN client_key          text,
  ADD COLUMN decision_due_at     timestamptz,
  ADD COLUMN assessment          jsonb,           -- vehicle gross-inaccuracy assessment kept with the decision
  ADD COLUMN override_request_id uuid REFERENCES audit.override_request (id),
  ADD COLUMN refund_journal_id   uuid REFERENCES ledger.journal (id),
  ADD COLUMN return_outcome      text CHECK (return_outcome IN ('withdrawn', 'listed')),
  ADD CONSTRAINT dispute_client_key_unique UNIQUE (raised_by, client_key),
  ADD CONSTRAINT dispute_refund_journal_check CHECK (refund_minor IS NULL OR status NOT IN ('upheld', 'partially_upheld') OR refund_journal_id IS NOT NULL),
  ADD CONSTRAINT dispute_return_check CHECK (return_outcome IS NULL OR remedy = 'full_refund_and_return');
CREATE UNIQUE INDEX dispute_one_open_per_lot_idx ON support.dispute (lot_id) WHERE status IN ('open', 'under_review');
CREATE INDEX dispute_queue_idx ON support.dispute (status, response_due_at);

-- A refund that cites an override must cite an approved refund override for this dispute and amount (R3).
-- The threshold itself is a rule (dispute.refund_second_approver_threshold), applied by the service.
CREATE FUNCTION support.guard_dispute_override() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.override_request_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM audit.override_request o
        WHERE o.id = NEW.override_request_id AND o.action_type = 'refund'
          AND o.entity_type = 'support.dispute' AND o.entity_id = NEW.id::text
          AND o.amount_minor = NEW.refund_minor AND o.status IN ('approved', 'executed')) THEN
    RAISE EXCEPTION 'dispute %: override % is not an approved refund of this amount for this dispute', NEW.id, NEW.override_request_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER dispute_override_guard BEFORE INSERT OR UPDATE OF override_request_id, refund_minor ON support.dispute
  FOR EACH ROW EXECUTE FUNCTION support.guard_dispute_override();

-- A lot enters 'refunded' only through an upheld full-refund-and-return decision.
CREATE FUNCTION support.guard_lot_refund() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'refunded' AND OLD.state IS DISTINCT FROM 'refunded' AND NOT EXISTS (
       SELECT 1 FROM support.dispute d
        WHERE d.lot_id = NEW.id AND d.status = 'upheld' AND d.remedy = 'full_refund_and_return') THEN
    RAISE EXCEPTION 'lot %: refunded needs an upheld full-refund dispute', NEW.lot_ref USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER lot_refund_guard BEFORE UPDATE OF state ON catalogue.lot
  FOR EACH ROW EXECUTE FUNCTION support.guard_lot_refund();

CREATE SEQUENCE support.ticket_number_seq;

CREATE TABLE support.ticket (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number              text NOT NULL UNIQUE DEFAULT 'T-' || lpad(nextval('support.ticket_number_seq')::text, 6, '0'),
  account_id                 uuid NOT NULL REFERENCES identity.account (id),   -- the customer
  opened_by                  uuid NOT NULL REFERENCES identity.account (id),   -- the customer, or staff taking a call
  channel                    text NOT NULL CHECK (channel IN ('web', 'whatsapp', 'phone', 'branch')),
  category                   text NOT NULL CHECK (category IN ('payment', 'collection', 'delivery', 'dispute', 'bidding',
                                                               'account', 'selling', 'other')),
  subject                    text NOT NULL CHECK (length(btrim(subject)) > 0),
  priority                   text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  status                     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending_customer', 'resolved', 'closed')),
  owner_staff_id             uuid REFERENCES identity.account (id),
  lot_id                     uuid REFERENCES catalogue.lot (id),
  invoice_id                 uuid REFERENCES settlement.invoice (id),
  dispute_id                 uuid REFERENCES support.dispute (id),
  client_key                 text,
  first_response_due_at      timestamptz NOT NULL,
  resolution_due_at          timestamptz NOT NULL,
  first_responded_at         timestamptz,
  resolved_at                timestamptz,
  first_response_breached_at timestamptz,
  resolution_breached_at     timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (opened_by, client_key),                 -- R4
  CHECK (resolution_due_at >= first_response_due_at),
  CHECK (status NOT IN ('resolved', 'closed') OR resolved_at IS NOT NULL)
);
CREATE INDEX ticket_queue_idx ON support.ticket (status, first_response_due_at);
CREATE INDEX ticket_account_idx ON support.ticket (account_id, created_at);

CREATE TRIGGER ticket_audit AFTER INSERT OR UPDATE ON support.ticket
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');
CREATE TRIGGER ticket_owner_audit AFTER UPDATE ON support.ticket
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('owner_staff_id');

CREATE TABLE support.ticket_message (
  id                bigserial PRIMARY KEY,
  ticket_id         uuid NOT NULL REFERENCES support.ticket (id),
  author_account_id uuid NOT NULL REFERENCES identity.account (id),
  author_kind       text NOT NULL CHECK (author_kind IN ('customer', 'staff')),
  body              text NOT NULL CHECK (length(btrim(body)) > 0),
  internal          boolean NOT NULL DEFAULT false,  -- staff-only note, never shown to the customer
  client_key        text,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (ticket_id, author_account_id, client_key),  -- R4
  CHECK (author_kind = 'staff' OR NOT internal)
);
CREATE INDEX ticket_message_ticket_idx ON support.ticket_message (ticket_id, id);

CREATE TRIGGER ticket_message_append_only BEFORE UPDATE OR DELETE ON support.ticket_message
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- -----------------------------------------------------------------------------
-- payout: holds while a dispute is open, and clawbacks. Owned by Payouts; defined
-- here because they reference disputes.
-- -----------------------------------------------------------------------------

CREATE TABLE payout.payout_hold (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id   uuid NOT NULL REFERENCES payout.payout (id),
  dispute_id  uuid NOT NULL REFERENCES support.dispute (id),
  held_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  UNIQUE (payout_id, dispute_id)
);
CREATE INDEX payout_hold_active_idx ON payout.payout_hold (payout_id) WHERE released_at IS NULL;

CREATE TRIGGER payout_hold_audit AFTER INSERT OR UPDATE ON payout.payout_hold
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('released_at');

-- A seller is never paid from under an open dispute.
CREATE FUNCTION payout.guard_payout_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('approved', 'processing', 'paid') AND OLD.status IS DISTINCT FROM NEW.status
     AND EXISTS (SELECT 1 FROM payout.payout_hold h WHERE h.payout_id = NEW.id AND h.released_at IS NULL) THEN
    RAISE EXCEPTION 'payout % is held while a dispute is open', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payout_hold_guard BEFORE UPDATE OF status ON payout.payout
  FOR EACH ROW EXECUTE FUNCTION payout.guard_payout_hold();

-- What a seller owes back after a refund made once they had been paid (A54).
CREATE TABLE payout.clawback (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_account_id uuid NOT NULL REFERENCES identity.account (id),
  currency          core.currency_code NOT NULL,
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  recovered_minor   bigint NOT NULL DEFAULT 0 CHECK (recovered_minor >= 0),
  dispute_id        uuid NOT NULL UNIQUE REFERENCES support.dispute (id),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'recovered')),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (recovered_minor <= amount_minor),
  CHECK ((status = 'recovered') = (recovered_minor = amount_minor))
);

CREATE TRIGGER clawback_audit AFTER INSERT OR UPDATE ON payout.clawback
  FOR EACH ROW EXECUTE FUNCTION audit.log_state_change('status');

CREATE TABLE payout.clawback_recovery (
  id           bigserial PRIMARY KEY,
  clawback_id  uuid NOT NULL REFERENCES payout.clawback (id),
  payout_id    uuid NOT NULL REFERENCES payout.payout (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  journal_id   uuid NOT NULL UNIQUE REFERENCES ledger.journal (id),
  recovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (clawback_id, payout_id)
);

CREATE TRIGGER clawback_recovery_append_only BEFORE UPDATE OR DELETE ON payout.clawback_recovery
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();
