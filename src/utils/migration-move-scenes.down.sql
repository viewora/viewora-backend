-- Rollback of migration-move-scenes.sql. Tours already split stay split; only the
-- "Move to new tour" action stops working (the API answers 503 without the function).
DROP FUNCTION IF EXISTS public.move_scenes_to_new_tour(UUID, UUID, UUID[], UUID[], TEXT, TEXT);
