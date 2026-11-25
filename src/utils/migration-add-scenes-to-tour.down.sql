-- Rollback of migration-add-scenes-to-tour.sql. Scenes already copied or moved stay where
-- they are; only "Add to existing tour" stops working (the API answers 503 without it).
DROP FUNCTION IF EXISTS public.add_scenes_to_tour(UUID, UUID, UUID, UUID[], UUID[], BOOLEAN);
DROP FUNCTION IF EXISTS public.files_still_used(TEXT[], TEXT[], UUID[]);
