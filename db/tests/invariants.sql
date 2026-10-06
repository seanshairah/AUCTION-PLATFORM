-- =============================================================================
-- Invariant tests for db/schema.sql. Run with db/tests/run.sh.
-- Each test tries to break one rule (R1–R4, lot states, currency separation)
-- and expects the database itself to refuse. Runs in one transaction, rolled back.
-- =============================================================================

\set ON_ERROR_STOP 1
SET client_min_messages = notice;

BEGIN;

CREATE SCHEMA test;

-- Runs statements and expects an error whose message matches p_pattern.
-- Deferred constraints are forced to fire inside the call.
CREATE FUNCTION test.expect_error(p_name text, p_stmts text[], p_pattern text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  s text;
BEGIN
  BEGIN
    FOREACH s IN ARRAY p_stmts LOOP
      EXECUTE s;
    END LOOP;
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    SET CONSTRAINTS ALL DEFERRED;
    IF SQLERRM ~* p_pattern THEN
      RAISE NOTICE 'PASS  %', p_name;
      RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL  %: wrong error: %', p_name, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL  %: expected an error matching "%"', p_name, p_pattern;
END $$;

-- Runs statements and expects success, with deferred constraints checked.
CREATE FUNCTION test.expect_ok(p_name text, p_stmts text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY p_stmts LOOP
    EXECUTE s;
  END LOOP;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RAISE NOTICE 'PASS  %', p_name;
END $$;

CREATE FUNCTION test.assert(p_name text, p_condition boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL  %', p_name;
  END IF;
  RAISE NOTICE 'PASS  %', p_name;
END $$;

-- -----------------------------------------------------------------------------
-- Fixtures
-- -----------------------------------------------------------------------------

SELECT audit.set_actor('system', 'test-runner', 'Invariant tests', 'fixture setup');

INSERT INTO identity.account (id, email, phone_e164, email_verified_at, phone_verified_at,
                              display_name, verification_level, tier) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'buyer@example.test',  '+263770000001', now(), now(), 'Buyer',  'partial', 'verified'),
  ('00000000-0000-0000-0000-0000000000b2', 'buyer2@example.test', '+263770000002', now(), now(), 'Buyer 2','partial', 'verified'),
  ('00000000-0000-0000-0000-0000000000a1', 'seller@example.test', '+263770000003', now(), now(), 'Seller', 'partial', 'verified'),
  ('00000000-0000-0000-0000-0000000000f1', 'staff1@example.test', '+263770000004', now(), now(), 'Staff One', 'partial', 'verified'),
  ('00000000-0000-0000-0000-0000000000f2', 'staff2@example.test', '+263770000005', now(), now(), 'Staff Two', 'partial', 'verified');

INSERT INTO ledger.book_account (id, owner_type, owner_id, purpose, sub_code, currency, normal_side, allow_negative) VALUES
  ('00000000-0000-0000-0000-00000000c001', 'customer', '00000000-0000-0000-0000-0000000000b1', 'wallet_available', '', 'USD', 'C', false),
  ('00000000-0000-0000-0000-00000000c002', 'customer', '00000000-0000-0000-0000-0000000000b1', 'wallet_held',      '', 'USD', 'C', false),
  ('00000000-0000-0000-0000-00000000c003', 'customer', '00000000-0000-0000-0000-0000000000b1', 'wallet_available', '', 'ZWG', 'C', false),
  ('00000000-0000-0000-0000-00000000c004', 'customer', '00000000-0000-0000-0000-0000000000b1', 'customer_receivable', '', 'USD', 'D', false),
  ('00000000-0000-0000-0000-00000000c010', 'gateway',  'paynow', 'gateway_clearing', '', 'USD', 'D', true),
  ('00000000-0000-0000-0000-00000000c011', 'seller',   '00000000-0000-0000-0000-0000000000a1', 'seller_payable', '', 'USD', 'C', false),
  ('00000000-0000-0000-0000-00000000c012', 'platform', NULL, 'tax_payable', 'vat', 'USD', 'C', false);

INSERT INTO rulebook.rule_set_version (id, label, effective_from, status, authored_by, approved_by, published_at) VALUES
  ('00000000-0000-0000-0000-00000000e001', 'test-published', now() - interval '1 day', 'published',
   '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2', now());

INSERT INTO seller.consignment (id, seller_account_id, consignment_type, intake_channel) VALUES
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'commission', 'portal');

INSERT INTO catalogue.lot (id, lot_ref, consignment_id, seller_account_id, category_code, is_vehicle, title, description,
                           item_state, condition, location_branch, settlement_currency, tax_class, starting_bid_minor) VALUES
  ('00000000-0000-0000-0000-0000000001a1', 'HRE-TEST-1', '00000000-0000-0000-0000-0000000000d1',
   '00000000-0000-0000-0000-0000000000a1', 'it', false, 'Laptop', 'A laptop', 'used', 'working', 'HRE', 'USD', 'goods_standard', 1000),
  ('00000000-0000-0000-0000-0000000001a2', 'HRE-TEST-2', '00000000-0000-0000-0000-0000000000d1',
   '00000000-0000-0000-0000-0000000000a1', 'vehicles', true, 'Pickup truck', 'A truck', 'used', 'as_is', 'HRE', 'USD', 'vehicle_standard', 100000);

INSERT INTO auction.auction (id, code, title, format, branch_code, status, rule_version_id, opens_at, first_close_at, created_by) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'TEST-A1', 'Test auction', 'timed_online', 'HRE', 'open',
   '00000000-0000-0000-0000-00000000e001', now() - interval '1 hour', now() + interval '1 day',
   '00000000-0000-0000-0000-0000000000f1');

INSERT INTO auction.auction_lot (id, auction_id, lot_id, currency, lot_number, starting_bid_minor, scheduled_end_at, current_end_at) VALUES
  ('00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000001a1',
   'USD', 1, 1000, now() + interval '1 day', now() + interval '1 day');

INSERT INTO registration.registration (id, account_id, auction_id, status, decided_by_type, decided_at, limit_snapshot) VALUES
  ('00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1',
   'approved', 'system', now(), '{"USD": {"limit_minor": 10000}}');

INSERT INTO comms.template (key, version, channel, category, body, status) VALUES
  ('outbid', 1, 'whatsapp', 'alert', 'You have been outbid on {{lot}}.', 'approved');

-- -----------------------------------------------------------------------------
-- R1: one double-entry ledger
-- -----------------------------------------------------------------------------

SELECT test.expect_ok('R1 balanced top-up posts', ARRAY[
  $$SELECT ledger.post_journal('top_up', 'USD', 'topup-1', 'EcoCash top-up',
      '[{"account": "00000000-0000-0000-0000-00000000c010", "amount": 5000},
        {"account": "00000000-0000-0000-0000-00000000c001", "amount": -5000}]')$$]);

SELECT test.assert('R1 wallet shows US$50.00 available',
  (SELECT available_minor FROM ledger.v_wallet
    WHERE account_id = '00000000-0000-0000-0000-0000000000b1' AND currency = 'USD') = 5000);

SELECT test.assert('R4 repeating a journal idempotency key returns the same journal and posts nothing',
  (SELECT ledger.post_journal('top_up', 'USD', 'topup-1', 'EcoCash top-up',
      '[{"account": "00000000-0000-0000-0000-00000000c010", "amount": 5000},
        {"account": "00000000-0000-0000-0000-00000000c001", "amount": -5000}]'))
   = (SELECT id FROM ledger.journal WHERE idempotency_key = 'topup-1')
  AND (SELECT balance_minor FROM ledger.book_account WHERE id = '00000000-0000-0000-0000-00000000c001') = 5000);

SELECT test.expect_error('R1 unbalanced journal is rejected at commit', ARRAY[
  $$SELECT ledger.post_journal('top_up', 'USD', 'topup-bad', 'Unbalanced',
      '[{"account": "00000000-0000-0000-0000-00000000c010", "amount": 5000},
        {"account": "00000000-0000-0000-0000-00000000c001", "amount": -4000}]')$$],
  'unbalanced');

SELECT test.expect_error('R1 single-line journal is rejected', ARRAY[
  $$SELECT ledger.post_journal('adjustment', 'USD', 'one-line', 'One line',
      '[{"account": "00000000-0000-0000-0000-00000000c010", "amount": 100}]')$$],
  'unbalanced');

SELECT test.expect_error('R1 a hold larger than the available balance is rejected', ARRAY[
  $$SELECT ledger.post_journal('hold', 'USD', 'hold-too-big', 'Deposit hold',
      '[{"account": "00000000-0000-0000-0000-00000000c001", "amount": 6000},
        {"account": "00000000-0000-0000-0000-00000000c002", "amount": -6000}]')$$],
  'book_account_check|violates check constraint');

SELECT test.expect_ok('R1 a hold within the balance moves available to held', ARRAY[
  $$SELECT ledger.post_journal('hold', 'USD', 'hold-1', 'Deposit hold',
      '[{"account": "00000000-0000-0000-0000-00000000c001", "amount": 2000},
        {"account": "00000000-0000-0000-0000-00000000c002", "amount": -2000}]')$$]);

SELECT test.assert('R1 wallet shows US$30.00 available and US$20.00 held',
  (SELECT (available_minor, held_minor) = (3000::bigint, 2000::bigint) FROM ledger.v_wallet
    WHERE account_id = '00000000-0000-0000-0000-0000000000b1' AND currency = 'USD'));

SELECT test.expect_error('R1 a USD journal cannot post to a ZiG account', ARRAY[
  $$SELECT ledger.post_journal('adjustment', 'USD', 'mixed-ccy', 'Mixed currency',
      '[{"account": "00000000-0000-0000-0000-00000000c010", "amount": 100},
        {"account": "00000000-0000-0000-0000-00000000c003", "amount": -100}]')$$],
  'foreign key');

SELECT test.expect_error('R1 postings cannot be updated', ARRAY[
  $$UPDATE ledger.posting SET amount_minor = amount_minor + 1$$], 'append-only');

SELECT test.expect_error('R1 journals cannot be deleted', ARRAY[
  $$DELETE FROM ledger.journal WHERE idempotency_key = 'topup-1'$$], 'append-only');

SELECT test.expect_error('R1 balances cannot be edited directly', ARRAY[
  $$UPDATE ledger.book_account SET balance_minor = 999999 WHERE id = '00000000-0000-0000-0000-00000000c001'$$],
  'only through ledger postings');

-- -----------------------------------------------------------------------------
-- R2: one rulebook
-- -----------------------------------------------------------------------------

SELECT test.expect_error('R2 published rule sets are immutable', ARRAY[
  $$INSERT INTO rulebook.rule_value (version_id, rule_key, value, provenance)
    VALUES ('00000000-0000-0000-0000-00000000e001', 'bidding.soft_close_seconds', '600', 'confirmed')$$],
  'immutable');

SELECT test.expect_error('R2 a rule set cannot be published by its own author alone', ARRAY[
  $$INSERT INTO rulebook.rule_set_version (label, effective_from, status, authored_by, approved_by, published_at)
    VALUES ('self-approved', now(), 'published', '00000000-0000-0000-0000-0000000000f1',
            '00000000-0000-0000-0000-0000000000f1', now())$$],
  'check constraint');

SELECT test.expect_ok('R2 an active tax rate can be loaded', ARRAY[
  $$INSERT INTO rulebook.tax_rate (id, tax_code, tax_class, currency, rate_bp, base, effective_from, active, provenance, approved_by)
    VALUES ('00000000-0000-0000-0000-00000000e002', 'vat', 'goods_standard', 'USD', 1550, 'hammer',
            '2026-01-01', true, 'benchmark', '00000000-0000-0000-0000-0000000000f2')$$]);

SELECT test.expect_error('R2 overlapping active tax rates for the same tax and class are rejected', ARRAY[
  $$INSERT INTO rulebook.tax_rate (tax_code, tax_class, currency, rate_bp, base, effective_from, active, provenance, approved_by)
    VALUES ('vat', 'goods_standard', 'USD', 1500, 'hammer', '2026-06-01', true, 'benchmark',
            '00000000-0000-0000-0000-0000000000f2')$$],
  'exclusion constraint|conflicting key');

SELECT test.expect_error('R2 a tax rate cannot be edited in place', ARRAY[
  $$UPDATE rulebook.tax_rate SET rate_bp = 1600 WHERE id = '00000000-0000-0000-0000-00000000e002'$$],
  'immutable');

-- -----------------------------------------------------------------------------
-- R3: audit and overrides
-- -----------------------------------------------------------------------------

SELECT test.expect_error('R3 a state change without an actor is rejected', ARRAY[
  $$SELECT set_config('app.actor_type', '', true)$$,
  $$UPDATE catalogue.lot SET state = 'listed' WHERE lot_ref = 'HRE-TEST-1'$$],
  'audit actor not set');

SELECT test.expect_error('R3 an override cannot be approved by the person who requested it', ARRAY[
  $$INSERT INTO audit.override_request (action_type, entity_type, entity_id, reason, requested_by,
                                        requires_second_approval, status, approved_by)
    VALUES ('bid_void', 'bidding.bid', 'x', 'Bidder confirmed a typing error', '00000000-0000-0000-0000-0000000000f1',
            true, 'approved', '00000000-0000-0000-0000-0000000000f1')$$],
  'check constraint');

SELECT test.expect_error('R3 an override above the threshold needs an approver', ARRAY[
  $$INSERT INTO audit.override_request (action_type, entity_type, entity_id, currency, amount_minor, reason,
                                        requested_by, requires_second_approval, status)
    VALUES ('refund', 'settlement.invoice', 'x', 'USD', 90000, 'Refund after upheld dispute',
            '00000000-0000-0000-0000-0000000000f1', true, 'approved')$$],
  'check constraint');

SELECT test.expect_error('R3 an override needs a real reason', ARRAY[
  $$INSERT INTO audit.override_request (action_type, entity_type, entity_id, reason, requested_by, requires_second_approval)
    VALUES ('limit_change', 'identity.account', 'x', 'ok', '00000000-0000-0000-0000-0000000000f1', false)$$],
  'check constraint');

-- -----------------------------------------------------------------------------
-- Lot state machine
-- -----------------------------------------------------------------------------

SELECT test.expect_error('Lot cannot be created past draft', ARRAY[
  $$INSERT INTO catalogue.lot (lot_ref, consignment_id, seller_account_id, category_code, is_vehicle, title, description,
                               item_state, condition, location_branch, settlement_currency, tax_class, starting_bid_minor, state)
    VALUES ('HRE-TEST-X', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'it', false,
            'X', 'X', 'used', 'working', 'HRE', 'USD', 'goods_standard', 1, 'live')$$],
  'starts in draft');

SELECT test.expect_error('Lot cannot jump from draft to live', ARRAY[
  $$UPDATE catalogue.lot SET state = 'live' WHERE lot_ref = 'HRE-TEST-1'$$], 'not allowed');

SELECT test.expect_error('Lot vehicle flag must match its category', ARRAY[
  $$INSERT INTO catalogue.lot (lot_ref, consignment_id, seller_account_id, category_code, is_vehicle, title, description,
                               item_state, condition, location_branch, settlement_currency, tax_class, starting_bid_minor)
    VALUES ('HRE-TEST-Y', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'vehicles', false,
            'Y', 'Y', 'used', 'as_is', 'HRE', 'USD', 'vehicle_standard', 1)$$],
  'foreign key');

SELECT test.expect_ok('Lot main path: draft → listed → live → closed → invoiced → paid → released → paid out', ARRAY[
  $$UPDATE catalogue.lot SET state = 'listed'   WHERE lot_ref = 'HRE-TEST-1'$$,
  $$UPDATE catalogue.lot SET state = 'live'     WHERE lot_ref = 'HRE-TEST-1'$$,
  $$UPDATE catalogue.lot SET state = 'closed'   WHERE lot_ref = 'HRE-TEST-1'$$,
  $$UPDATE catalogue.lot SET state = 'invoiced' WHERE lot_ref = 'HRE-TEST-1'$$,
  $$UPDATE catalogue.lot SET state = 'paid'     WHERE lot_ref = 'HRE-TEST-1'$$,
  $$UPDATE catalogue.lot SET state = 'released' WHERE lot_ref = 'HRE-TEST-1'$$,
  $$UPDATE catalogue.lot SET state = 'paid_out' WHERE lot_ref = 'HRE-TEST-1'$$]);

SELECT test.assert('R3 every lot transition was audited with its actor',
  (SELECT count(*) FROM audit.event
    WHERE entity_type = 'catalogue.lot' AND entity_id = '00000000-0000-0000-0000-0000000001a1'
      AND action = 'state_change' AND actor_id = 'test-runner') = 7);

SELECT test.expect_error('Lot in a terminal state cannot move', ARRAY[
  $$UPDATE catalogue.lot SET state = 'listed' WHERE lot_ref = 'HRE-TEST-1'$$], 'not allowed');

SELECT test.expect_ok('Vehicle reaches paid', ARRAY[
  $$UPDATE catalogue.lot SET state = 'listed'   WHERE lot_ref = 'HRE-TEST-2'$$,
  $$UPDATE catalogue.lot SET state = 'live'     WHERE lot_ref = 'HRE-TEST-2'$$,
  $$UPDATE catalogue.lot SET state = 'closed'   WHERE lot_ref = 'HRE-TEST-2'$$,
  $$UPDATE catalogue.lot SET state = 'invoiced' WHERE lot_ref = 'HRE-TEST-2'$$,
  $$UPDATE catalogue.lot SET state = 'paid'     WHERE lot_ref = 'HRE-TEST-2'$$]);

SELECT test.expect_error('Vehicle cannot skip the title hold', ARRAY[
  $$UPDATE catalogue.lot SET state = 'released' WHERE lot_ref = 'HRE-TEST-2'$$], 'title steps');

SELECT test.expect_error('Non-vehicle cannot enter the title hold', ARRAY[
  $$INSERT INTO catalogue.lot (lot_ref, consignment_id, seller_account_id, category_code, is_vehicle, title, description,
                               item_state, condition, location_branch, settlement_currency, tax_class, starting_bid_minor)
    VALUES ('HRE-TEST-Z', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'it', false,
            'Z', 'Z', 'used', 'working', 'HRE', 'USD', 'goods_standard', 1)$$,
  $$UPDATE catalogue.lot SET state = 'listed'   WHERE lot_ref = 'HRE-TEST-Z'$$,
  $$UPDATE catalogue.lot SET state = 'live'     WHERE lot_ref = 'HRE-TEST-Z'$$,
  $$UPDATE catalogue.lot SET state = 'closed'   WHERE lot_ref = 'HRE-TEST-Z'$$,
  $$UPDATE catalogue.lot SET state = 'invoiced' WHERE lot_ref = 'HRE-TEST-Z'$$,
  $$UPDATE catalogue.lot SET state = 'paid'     WHERE lot_ref = 'HRE-TEST-Z'$$,
  $$UPDATE catalogue.lot SET state = 'title_hold' WHERE lot_ref = 'HRE-TEST-Z'$$],
  'only vehicles');

SELECT test.expect_ok('Vehicle enters the title hold with a title case', ARRAY[
  $$UPDATE catalogue.lot SET state = 'title_hold' WHERE lot_ref = 'HRE-TEST-2'$$,
  $$INSERT INTO logistics.title_case (id, lot_id, buyer_account_id, deadline_at)
    VALUES ('00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000001a2',
            '00000000-0000-0000-0000-0000000000b1', now() + interval '14 days')$$]);

SELECT test.expect_error('Vehicle cannot be released while its title case is open', ARRAY[
  $$UPDATE catalogue.lot SET state = 'released' WHERE lot_ref = 'HRE-TEST-2'$$], 'title case is not complete');

SELECT test.expect_error('Title case cannot complete with steps outstanding', ARRAY[
  $$INSERT INTO logistics.title_step (title_case_id, step, sort, owner_party, due_at, status, evidence_object_key, completed_by, completed_at)
    VALUES ('00000000-0000-0000-0000-0000000004a1', 'zrp_clearance', 1, 'abc', now(), 'done', 'ev/zrp.pdf',
            '00000000-0000-0000-0000-0000000000f1', now())$$,
  $$UPDATE logistics.title_case SET status = 'complete', completed_at = now()
     WHERE id = '00000000-0000-0000-0000-0000000004a1'$$],
  'must all be done');

SELECT test.expect_error('Title step cannot be marked done without evidence', ARRAY[
  $$INSERT INTO logistics.title_step (title_case_id, step, sort, owner_party, due_at, status, completed_by, completed_at)
    VALUES ('00000000-0000-0000-0000-0000000004a1', 'zrp_clearance', 1, 'abc', now(), 'done',
            '00000000-0000-0000-0000-0000000000f1', now())$$],
  'check constraint');

SELECT test.expect_ok('Vehicle is released once ZRP, ZIMRA and CVR steps are done', ARRAY[
  $$INSERT INTO logistics.title_step (title_case_id, step, sort, owner_party, due_at, status, evidence_object_key, completed_by, completed_at)
    SELECT '00000000-0000-0000-0000-0000000004a1', s.step, s.sort, 'abc', now(), 'done', 'ev/' || s.step || '.pdf',
           '00000000-0000-0000-0000-0000000000f1', now()
      FROM (VALUES ('zrp_clearance', 1), ('zimra_clearance', 2), ('cvr_change_of_ownership', 3)) AS s(step, sort)$$,
  $$UPDATE logistics.title_case SET status = 'complete', completed_at = now()
     WHERE id = '00000000-0000-0000-0000-0000000004a1'$$,
  $$UPDATE catalogue.lot SET state = 'released' WHERE lot_ref = 'HRE-TEST-2'$$]);

-- -----------------------------------------------------------------------------
-- Bids: immutable log, idempotency, currency
-- -----------------------------------------------------------------------------

SELECT test.expect_ok('Bid is recorded with sequence number and commit-screen quote', ARRAY[
  $$INSERT INTO bidding.bid (id, auction_lot_id, currency, account_id, registration_id, origin, client_request_id,
                             sequence_no, amount_minor, max_amount_minor, outcome_at_placement,
                             quoted_total_minor, quoted_rule_version_id, channel)
    VALUES ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000002a1', 'USD',
            '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000003a1', 'bidder', 'req-1',
            1, 1000, 2500, 'leading', 2888, '00000000-0000-0000-0000-00000000e001', 'android')$$]);

SELECT test.expect_error('R4 the same client request id cannot place a second bid', ARRAY[
  $$INSERT INTO bidding.bid (auction_lot_id, currency, account_id, registration_id, origin, client_request_id,
                             sequence_no, amount_minor, max_amount_minor, outcome_at_placement,
                             quoted_total_minor, quoted_rule_version_id, channel)
    VALUES ('00000000-0000-0000-0000-0000000002a1', 'USD', '00000000-0000-0000-0000-0000000000b1',
            '00000000-0000-0000-0000-0000000003a1', 'bidder', 'req-1', 2, 1100, 2500, 'leading',
            3177, '00000000-0000-0000-0000-00000000e001', 'android')$$],
  'duplicate key');

SELECT test.expect_error('Bid sequence numbers are unique per lot', ARRAY[
  $$INSERT INTO bidding.bid (auction_lot_id, currency, account_id, registration_id, origin, client_request_id,
                             sequence_no, amount_minor, max_amount_minor, outcome_at_placement,
                             quoted_total_minor, quoted_rule_version_id, channel)
    VALUES ('00000000-0000-0000-0000-0000000002a1', 'USD', '00000000-0000-0000-0000-0000000000b1',
            '00000000-0000-0000-0000-0000000003a1', 'bidder', 'req-2', 1, 1100, 2500, 'leading',
            3177, '00000000-0000-0000-0000-00000000e001', 'android')$$],
  'duplicate key');

SELECT test.expect_error('A bid must be in the lot''s settlement currency', ARRAY[
  $$INSERT INTO bidding.bid (auction_lot_id, currency, account_id, registration_id, origin, client_request_id,
                             sequence_no, amount_minor, max_amount_minor, outcome_at_placement,
                             quoted_total_minor, quoted_rule_version_id, channel)
    VALUES ('00000000-0000-0000-0000-0000000002a1', 'ZWG', '00000000-0000-0000-0000-0000000000b1',
            '00000000-0000-0000-0000-0000000003a1', 'bidder', 'req-3', 3, 1100, 2500, 'leading',
            3177, '00000000-0000-0000-0000-00000000e001', 'android')$$],
  'foreign key');

SELECT test.expect_error('A bidder''s bid must carry the all-in total shown at commit', ARRAY[
  $$INSERT INTO bidding.bid (auction_lot_id, currency, account_id, registration_id, origin, client_request_id,
                             sequence_no, amount_minor, max_amount_minor, outcome_at_placement, channel)
    VALUES ('00000000-0000-0000-0000-0000000002a1', 'USD', '00000000-0000-0000-0000-0000000000b1',
            '00000000-0000-0000-0000-0000000003a1', 'bidder', 'req-4', 4, 1100, 2500, 'leading', 'android')$$],
  'check constraint');

SELECT test.expect_error('Bids cannot be edited', ARRAY[
  $$UPDATE bidding.bid SET amount_minor = 1 WHERE id = '00000000-0000-0000-0000-0000000005a1'$$], 'append-only');

SELECT test.expect_error('Bids cannot be deleted', ARRAY[
  $$DELETE FROM bidding.bid WHERE id = '00000000-0000-0000-0000-0000000005a1'$$], 'append-only');

SELECT test.expect_error('R3 a bid cannot be voided without an approved override', ARRAY[
  $$INSERT INTO audit.override_request (id, action_type, entity_type, entity_id, reason, requested_by, requires_second_approval)
    VALUES ('00000000-0000-0000-0000-0000000006a1', 'bid_void', 'bidding.bid', '00000000-0000-0000-0000-0000000005a1',
            'Bidder confirmed a typing error by phone', '00000000-0000-0000-0000-0000000000f1', true)$$,
  $$INSERT INTO bidding.bid_void (bid_id, override_request_id, voided_by, reason)
    VALUES ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000006a1',
            '00000000-0000-0000-0000-0000000000f1', 'Bidder confirmed a typing error by phone')$$],
  'not an approved bid_void');

SELECT test.expect_ok('R3 a bid is voided after a second person approves', ARRAY[
  $$INSERT INTO audit.override_request (id, action_type, entity_type, entity_id, reason, requested_by,
                                        requires_second_approval, status, approved_by, decided_at)
    VALUES ('00000000-0000-0000-0000-0000000006a2', 'bid_void', 'bidding.bid', '00000000-0000-0000-0000-0000000005a1',
            'Bidder confirmed a typing error by phone', '00000000-0000-0000-0000-0000000000f1',
            true, 'approved', '00000000-0000-0000-0000-0000000000f2', now())$$,
  $$INSERT INTO bidding.bid_void (bid_id, override_request_id, voided_by, reason)
    VALUES ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000006a2',
            '00000000-0000-0000-0000-0000000000f1', 'Bidder confirmed a typing error by phone')$$]);

-- -----------------------------------------------------------------------------
-- Invoices, payments, collection, payouts, messages
-- -----------------------------------------------------------------------------

SELECT test.expect_error('Invoice total must equal the sum of its lines', ARRAY[
  $$INSERT INTO settlement.invoice (id, invoice_number, buyer_account_id, auction_id, currency, rule_version_id,
                                    due_at, collect_by_at, total_minor)
    VALUES ('00000000-0000-0000-0000-0000000007a1', 'INV-BAD', '00000000-0000-0000-0000-0000000000b1',
            '00000000-0000-0000-0000-0000000000e1', 'USD', '00000000-0000-0000-0000-00000000e001',
            now() + interval '48 hours', now() + interval '96 hours', 1500)$$,
  $$INSERT INTO settlement.invoice_line (invoice_id, currency, line_type, description, amount_minor)
    VALUES ('00000000-0000-0000-0000-0000000007a1', 'USD', 'hammer', 'Hammer', 1000)$$],
  'does not equal sum of lines');

SELECT test.expect_ok('Invoice with matching lines is issued', ARRAY[
  $$INSERT INTO settlement.invoice (id, invoice_number, buyer_account_id, auction_id, currency, rule_version_id,
                                    due_at, collect_by_at, total_minor)
    VALUES ('00000000-0000-0000-0000-0000000007a2', 'INV-1', '00000000-0000-0000-0000-0000000000b1',
            '00000000-0000-0000-0000-0000000000e1', 'USD', '00000000-0000-0000-0000-00000000e001',
            now() + interval '48 hours', now() + interval '96 hours', 1155)$$,
  $$INSERT INTO settlement.invoice_line (invoice_id, currency, auction_lot_id, line_type, description, amount_minor)
    VALUES ('00000000-0000-0000-0000-0000000007a2', 'USD', '00000000-0000-0000-0000-0000000002a1', 'hammer', 'Hammer', 1000)$$,
  $$INSERT INTO settlement.invoice_line (invoice_id, currency, line_type, description, base_minor, rate_bp, amount_minor, tax_rate_id)
    VALUES ('00000000-0000-0000-0000-0000000007a2', 'USD', 'vat', 'VAT 15.5%', 1000, 1550, 155,
            '00000000-0000-0000-0000-00000000e002')$$]);

SELECT test.expect_error('Invoice lines cannot be edited after issue', ARRAY[
  $$UPDATE settlement.invoice_line SET amount_minor = 0 WHERE invoice_id = '00000000-0000-0000-0000-0000000007a2'$$],
  'append-only');

SELECT test.expect_error('Invoice line currency must match the invoice', ARRAY[
  $$INSERT INTO settlement.invoice_line (invoice_id, currency, line_type, description, amount_minor)
    VALUES ('00000000-0000-0000-0000-0000000007a2', 'ZWG', 'adjustment', 'Wrong currency', 1)$$],
  'foreign key');

SELECT test.expect_error('Goods are not released against an unpaid invoice', ARRAY[
  $$INSERT INTO logistics.collection (invoice_id, method, status, released_at, released_by)
    VALUES ('00000000-0000-0000-0000-0000000007a2', 'pickup', 'released', now(), '00000000-0000-0000-0000-0000000000f1')$$],
  'invoice is not paid');

SELECT test.expect_ok('Payment from a gateway is recorded once per gateway reference', ARRAY[
  $$INSERT INTO payment.payment (account_id, purpose, method, gateway, currency, amount_minor, status,
                                 client_idempotency_key, gateway_reference, journal_id, confirmed_at)
    SELECT '00000000-0000-0000-0000-0000000000b1', 'top_up', 'ecocash', 'paynow', 'USD', 5000, 'succeeded',
           'client-1', 'PN-123', id, now()
      FROM ledger.journal WHERE idempotency_key = 'topup-1'$$]);

SELECT test.expect_error('R4 a duplicate gateway reference is rejected', ARRAY[
  $$INSERT INTO payment.payment (account_id, purpose, method, gateway, currency, amount_minor,
                                 client_idempotency_key, gateway_reference)
    VALUES ('00000000-0000-0000-0000-0000000000b1', 'top_up', 'ecocash', 'paynow', 'USD', 5000, 'client-2', 'PN-123')$$],
  'duplicate key');

SELECT test.expect_error('R4 a duplicate client payment key is rejected', ARRAY[
  $$INSERT INTO payment.payment (account_id, purpose, method, gateway, currency, amount_minor, client_idempotency_key)
    VALUES ('00000000-0000-0000-0000-0000000000b1', 'top_up', 'ecocash', 'paynow', 'USD', 5000, 'client-1')$$],
  'duplicate key');

SELECT test.expect_error('InnBucks is offered for USD only', ARRAY[
  $$INSERT INTO payment.payment (account_id, purpose, method, gateway, currency, amount_minor, client_idempotency_key)
    VALUES ('00000000-0000-0000-0000-0000000000b1', 'top_up', 'innbucks', 'paynow', 'ZWG', 5000, 'client-3')$$],
  'check constraint');

SELECT test.expect_error('Branch cash needs a receipt number, branch and cashier', ARRAY[
  $$INSERT INTO payment.payment (account_id, purpose, method, gateway, currency, amount_minor, client_idempotency_key)
    VALUES ('00000000-0000-0000-0000-0000000000b1', 'top_up', 'branch_cash', 'branch', 'USD', 5000, 'client-4')$$],
  'check constraint');

SELECT test.expect_error('A payment marked succeeded must have a ledger journal', ARRAY[
  $$INSERT INTO payment.payment (account_id, purpose, method, gateway, currency, amount_minor, status,
                                 client_idempotency_key, confirmed_at)
    VALUES ('00000000-0000-0000-0000-0000000000b1', 'top_up', 'ecocash', 'paynow', 'USD', 5000, 'succeeded',
            'client-5', now())$$],
  'check constraint');

SELECT test.expect_ok('Notification is queued', ARRAY[
  $$INSERT INTO comms.message (message_key, recipient_account_id, channel, template_key, template_version, locale)
    VALUES ('outbid:00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000000b1',
            'whatsapp', 'outbid', 1, 'en-ZW')$$]);

SELECT test.expect_error('R4 the same message is never sent twice on the same channel', ARRAY[
  $$INSERT INTO comms.message (message_key, recipient_account_id, channel, template_key, template_version, locale)
    VALUES ('outbid:00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000000b1',
            'whatsapp', 'outbid', 1, 'en-ZW')$$],
  'duplicate key');

SELECT test.expect_error('Payout header must match its lines', ARRAY[
  $$INSERT INTO payout.payout (id, seller_account_id, currency, due_date, gross_minor, deductions_minor, net_minor)
    VALUES ('00000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-0000000000a1', 'USD',
            current_date + 7, 1000, 100, 900)$$,
  $$INSERT INTO payout.payout_line (payout_id, line_type, description, amount_minor)
    VALUES ('00000000-0000-0000-0000-0000000008a1', 'hammer', 'Hammer', 1000)$$],
  'does not match lines');

SELECT test.expect_ok('Payout with hammer and commission lines is scheduled', ARRAY[
  $$INSERT INTO payout.payout (id, seller_account_id, currency, due_date, gross_minor, deductions_minor, net_minor)
    VALUES ('00000000-0000-0000-0000-0000000008a2', '00000000-0000-0000-0000-0000000000a1', 'USD',
            current_date + 7, 1000, 100, 900)$$,
  $$INSERT INTO payout.payout_line (payout_id, line_type, description, amount_minor)
    VALUES ('00000000-0000-0000-0000-0000000008a2', 'hammer', 'Hammer', 1000),
           ('00000000-0000-0000-0000-0000000008a2', 'commission', 'Commission', -100)$$]);

SELECT test.expect_error('Account cannot be Trusted without full verification', ARRAY[
  $$UPDATE identity.account SET tier = 'trusted' WHERE id = '00000000-0000-0000-0000-0000000000b2'$$],
  'check constraint');

SELECT test.expect_error('National ID numbers are unique across accounts', ARRAY[
  $$UPDATE identity.account SET national_id_hmac = '\x01', national_id_enc = '\x02'
     WHERE id = '00000000-0000-0000-0000-0000000000b1'$$,
  $$UPDATE identity.account SET national_id_hmac = '\x01', national_id_enc = '\x03'
     WHERE id = '00000000-0000-0000-0000-0000000000b2'$$],
  'duplicate key');

SELECT 'ALL INVARIANT TESTS PASSED' AS result;

ROLLBACK;
