-- Rollback for migration-narration.sql. The MP3s stay in R2 under narration/.
DROP TABLE IF EXISTS narration_jobs;
DROP TABLE IF EXISTS narration_audio;
ALTER TABLE journeys DROP COLUMN IF EXISTS narration_voice;
NOTIFY pgrst, 'reload schema';
