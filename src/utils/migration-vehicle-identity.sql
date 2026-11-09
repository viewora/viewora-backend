-- Migration: a car's identity (VIN or chassis number, make, model, trim)
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-vehicle-identity.down.sql
--
-- Additive: four nullable columns on properties. Only automotive spaces use them;
-- the editor's "Decode VIN" fills make, model and trim from a 17-character VIN.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS vehicle_vin TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS vehicle_make TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS vehicle_model TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS vehicle_trim TEXT;

NOTIFY pgrst, 'reload schema';
