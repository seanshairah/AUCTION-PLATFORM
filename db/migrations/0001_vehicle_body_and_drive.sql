-- Body style and drive for vehicle search filters (web dashboard, deliverable 6 filters).
-- Folded into db/schema.sql as well; this file brings existing databases up to date.
ALTER TABLE catalogue.vehicle
  ADD COLUMN body_style text CHECK (body_style IN ('sedan', 'hatchback', 'suv', 'pickup', 'van', 'truck', 'bus', 'coupe', 'wagon', 'other')),
  ADD COLUMN drive      text CHECK (drive IN ('2wd', '4wd', 'awd'));
CREATE INDEX vehicle_make_model_idx ON catalogue.vehicle (make, model);
