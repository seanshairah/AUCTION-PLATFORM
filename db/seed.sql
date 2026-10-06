-- =============================================================================
-- Reference data. Loaded after schema.sql. Safe to re-run.
-- Provenance per row is noted; see docs/00-assumptions-register.md for tags.
-- =============================================================================

BEGIN;

-- Branches (CONFIRMED: Harare and Bulawayo). Hours CONFIRMED: 9am–3pm weekdays, 9am–12pm Saturdays.
INSERT INTO core.branch (code, name, city, opening_hours) VALUES
  ('HRE', 'ABC Auctions Harare',   'Harare',   '{"mon_fri": "09:00-15:00", "sat": "09:00-12:00"}'),
  ('BYO', 'ABC Auctions Bulawayo', 'Bulawayo', '{"mon_fri": "09:00-15:00", "sat": "09:00-12:00"}')
ON CONFLICT (code) DO NOTHING;

-- Item state vocabulary (D1: build brief's list; ABC to confirm it matches the help desk).
INSERT INTO catalogue.item_state_term (code, label, description, sort) VALUES
  ('new',          'New',            'Unused, in original packaging.', 1),
  ('new_open_box', 'New – Open Box', 'Unused, but the packaging has been opened.', 2),
  ('used',         'Used',           'Previously used.', 3),
  ('renewed',      'Renewed',        'Previously used and restored to working order.', 4)
ON CONFLICT (code) DO NOTHING;

-- Condition vocabulary (D1).
INSERT INTO catalogue.condition_term (code, label, description, sort) VALUES
  ('as_is',          'As Is',          'Sold in its current state with no claim about condition or function.', 1),
  ('working',        'Working',        'Tested and working at intake.', 2),
  ('untested',       'Untested',       'Not tested. Function unknown.', 3),
  ('partly_working', 'Partly Working', 'Some functions work; faults are described in the notes.', 4),
  ('damaged',        'Damaged',        'Visible damage, described and photographed.', 5),
  ('broken',         'Broken',         'Does not work because of physical damage.', 6),
  ('incomplete',     'Incomplete',     'Parts or accessories are missing, listed in the notes.', 7),
  ('sealed_packing', 'Sealed Packing', 'In unopened sealed packing; contents not inspected.', 8),
  ('not_working',    'Not Working',    'Tested and does not work.', 9)
ON CONFLICT (code) DO NOTHING;

-- Example categories. Deposit-required categories (vehicles, IT, catering, special) are
-- CONFIRMED; the deposit rule itself lives in the rulebook. Tax classes are placeholders
-- until finance answers Q9.
INSERT INTO catalogue.category (code, parent_code, name, is_vehicle, tax_class) VALUES
  ('vehicles',          NULL,       'Vehicles',                  true,  'vehicle_standard'),
  ('vehicles_used_zw',  'vehicles', 'Used vehicles (ZW-registered)', true, 'vehicle_used_zw'),
  ('it',                NULL,       'IT and electronics',        false, 'goods_standard'),
  ('catering',          NULL,       'Catering equipment',        false, 'goods_standard'),
  ('furniture',         NULL,       'Furniture',                 false, 'goods_standard'),
  ('general',           NULL,       'General goods',             false, 'goods_standard'),
  ('special',           NULL,       'Special auctions',          false, 'goods_standard')
ON CONFLICT (code) DO NOTHING;

COMMIT;
