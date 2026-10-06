-- Admin and operations services (deliverable 18) and analytics (deliverable 19).
-- docs/18-admin-operations.md and docs/19-analytics.md. Folded into db/schema.sql as
-- well; this file brings existing databases up to date. No BEGIN/COMMIT: the
-- migration runner wraps it in one transaction.

-- -----------------------------------------------------------------------------
-- audit: override requests carry what they will do, lapse, and are never edited (R3)
-- -----------------------------------------------------------------------------

ALTER TABLE audit.override_request DROP CONSTRAINT override_request_action_type_check;
ALTER TABLE audit.override_request
  ADD CONSTRAINT override_request_action_type_check CHECK (action_type IN
    ('refund', 'bid_void', 'limit_change', 'fee_waiver', 'payout_detail_override', 'lot_withdrawal', 'tier_change',
     'deposit_forfeit_waiver', 'ledger_adjustment', 'tax_rate_activation'));
ALTER TABLE audit.override_request
  ADD COLUMN payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN expires_at  timestamptz,
  ADD COLUMN executed_at timestamptz,
  ADD COLUMN client_key  text,
  ADD CONSTRAINT override_request_client_key_unique UNIQUE (requested_by, client_key),
  ADD CONSTRAINT override_request_expiry CHECK (expires_at IS NULL OR expires_at > requested_at),
  ADD CONSTRAINT override_request_rejection_note CHECK (status <> 'rejected' OR length(btrim(coalesce(decision_note, ''))) >= 5),
  ADD CONSTRAINT override_request_executed_at CHECK ((status = 'executed') = (executed_at IS NOT NULL));

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

-- -----------------------------------------------------------------------------
-- rulebook: warnings acknowledged by name; one effective version; tax activation (R2)
-- -----------------------------------------------------------------------------

-- Two published versions can never share an effective time, so exactly one is in force at any moment.
CREATE UNIQUE INDEX rule_set_version_one_effective_idx ON rulebook.rule_set_version (effective_from) WHERE status = 'published';

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

-- Activating a tax rate needs finance's two-person approval (Q9).
ALTER TABLE rulebook.tax_rate ADD COLUMN activation_override_id uuid REFERENCES audit.override_request (id);

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
-- ledger: an expense account for approved reconciliation write-offs (R1)
-- -----------------------------------------------------------------------------

ALTER TABLE ledger.book_account DROP CONSTRAINT book_account_purpose_check;
ALTER TABLE ledger.book_account
  ADD CONSTRAINT book_account_purpose_check CHECK (purpose IN (
    'wallet_available', 'wallet_held', 'customer_receivable', 'seller_payable',
    'gateway_clearing', 'branch_cash', 'trust_bank',
    'commission_income', 'fee_income', 'delivery_income', 'forfeiture_income',
    'tax_payable', 'fx_clearing', 'suspense', 'write_off'));

-- -----------------------------------------------------------------------------
-- registration: staff decisions on the review queue carry a note
-- -----------------------------------------------------------------------------

ALTER TABLE registration.registration
  ADD COLUMN decision_note text,
  ADD CONSTRAINT registration_staff_decision_note
    CHECK (decided_by_type IS DISTINCT FROM 'staff' OR length(btrim(coalesce(decision_note, ''))) >= 10);

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

-- -----------------------------------------------------------------------------
-- settlement: appeals against the default ladder, and waivers (blueprint module 7)
-- -----------------------------------------------------------------------------

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
-- payment: resolving reconciliation exceptions
-- -----------------------------------------------------------------------------

ALTER TABLE payment.reconciliation_item
  ADD COLUMN resolution          text CHECK (resolution IN ('matched_manually', 'gateway_error', 'within_tolerance', 'written_off')),
  ADD COLUMN override_request_id uuid REFERENCES audit.override_request (id),
  ADD COLUMN journal_id          uuid REFERENCES ledger.journal (id),
  ADD CONSTRAINT reconciliation_item_resolution_complete CHECK ((resolution IS NULL) = (resolved_at IS NULL)),
  ADD CONSTRAINT reconciliation_item_resolution_note CHECK (resolution IS NULL OR length(btrim(coalesce(resolution_note, ''))) >= 10),
  ADD CONSTRAINT reconciliation_item_write_off CHECK (resolution IS DISTINCT FROM 'written_off'
                                                      OR (journal_id IS NOT NULL AND override_request_id IS NOT NULL));

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
-- analytics: blueprint §9 measures as read-only functions, and the frozen baseline
-- -----------------------------------------------------------------------------

-- Analytics reads the replica: every measure is a STABLE SQL function over domain
-- tables and the outbox, so it never writes. Periods are half-open [p_from, p_to).
-- p_branch NULL means every branch. Money is never summed across currencies.
CREATE SCHEMA analytics;

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
