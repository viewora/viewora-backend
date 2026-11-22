-- Migration: move scenes (and chosen gallery photos) out of a tour into a new tour.
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-move-scenes.down.sql
--
-- Used by POST /spaces/:id/move-scenes (routes/spaces.ts). One function, one transaction:
-- either the new tour exists with every chosen scene and photo in it, or nothing changed.
--
-- What it does:
--   * New tour = a copy of the source tour's row (details, logo, socials, contact, CTA,
--     branding, listing facts…) with a new id and title. Published at p_slug when given,
--     otherwise a draft. Every column is copied generically, so columns added later
--     come along too; generated/identity columns are skipped.
--   * Viewer settings (property_360_settings: start view, auto-rotate, tripod cover) are copied.
--   * Chosen scenes move: space_id changes, order kept (renumbered from 0). Their hotspots,
--     info points and spotlights move with them. Floor-plan pins are cleared (floor plans
--     stay with the source tour).
--   * Arrows between a moved scene and a scene that stays are deleted, both directions.
--   * Each moved scene's panorama upload (property_media 'panorama') moves too, so storage
--     is accounted to the tour that shows it, and deleting the source tour later can't
--     remove its files. Files are NOT copied: they stay at their R2 keys and URLs.
--   * Chosen gallery photos move (property_media 'gallery_image'). None chosen = none move.
--   * The tour limit trigger (migration-tour-quota-enforcement.sql) still applies to the insert.
--
-- Callable by the service role only (it trusts p_user).

CREATE OR REPLACE FUNCTION public.move_scenes_to_new_tour(
  p_user      UUID,
  p_source    UUID,
  p_scene_ids UUID[],
  p_photo_ids UUID[],
  p_title     TEXT,
  p_slug      TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src       JSONB;
  v_new_id    UUID := gen_random_uuid();
  v_cols      TEXT;
  v_settings  JSONB;
  v_scenes    INT;
  v_photos    INT := 0;
  v_links     INT := 0;
  v_panos     INT := 0;
  v_ids       UUID[] := ARRAY(SELECT DISTINCT unnest(p_scene_ids));
  v_photo_ids UUID[] := ARRAY(SELECT DISTINCT unnest(coalesce(p_photo_ids, '{}'::uuid[])));
BEGIN
  SELECT to_jsonb(p) INTO v_src FROM properties p WHERE p.id = p_source AND p.user_id = p_user FOR UPDATE;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'MOVE_SOURCE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF coalesce(array_length(v_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'MOVE_NO_SCENES' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM scenes WHERE id = ANY(v_ids) AND space_id = p_source) <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'MOVE_SCENE_NOT_IN_TOUR' USING ERRCODE = 'P0001';
  END IF;
  IF coalesce(array_length(v_photo_ids, 1), 0) > 0 AND (
    SELECT count(*) FROM property_media
    WHERE id = ANY(v_photo_ids) AND property_id = p_source AND media_type = 'gallery_image'
  ) <> array_length(v_photo_ids, 1) THEN
    RAISE EXCEPTION 'MOVE_PHOTO_NOT_IN_TOUR' USING ERRCODE = 'P0001';
  END IF;

  -- 1. The new tour: the source row with a new identity. Keys that aren't columns are ignored.
  v_src := v_src || jsonb_build_object(
    'id',              v_new_id,
    'title',           p_title,
    'slug',            p_slug,
    'is_published',    p_slug IS NOT NULL,
    'visibility',      CASE WHEN p_slug IS NOT NULL THEN 'public' ELSE 'private' END,
    'published_at',    CASE WHEN p_slug IS NOT NULL THEN now() END,
    'created_at',      now(),
    'updated_at',      now(),
    'cover_image_url', NULL,
    'view_count',      0,
    'deleted_at',      NULL,
    'has_360',         true,
    'has_gallery',     coalesce(array_length(v_photo_ids, 1), 0) > 0
  );
  SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'properties'
    AND is_generated = 'NEVER' AND is_identity = 'NO';
  EXECUTE format('INSERT INTO properties (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::properties, $1)', v_cols)
    USING v_src;

  -- 2. Viewer settings (one row per tour, keyed by property_id).
  SELECT to_jsonb(s) INTO v_settings FROM property_360_settings s WHERE s.property_id = p_source LIMIT 1;
  IF v_settings IS NOT NULL THEN
    v_settings := v_settings || jsonb_build_object('property_id', v_new_id, 'panorama_media_id', NULL, 'hotspots_json', NULL);
    SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'property_360_settings'
      AND is_generated = 'NEVER' AND is_identity = 'NO' AND column_name <> 'id';
    EXECUTE format('INSERT INTO property_360_settings (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::property_360_settings, $1)', v_cols)
      USING v_settings;
  END IF;

  -- 3. Cut arrows that would cross between the two tours (both directions).
  DELETE FROM hotspots h
  USING scenes s
  WHERE h.scene_id = s.id
    AND h.target_scene_id IS NOT NULL
    AND (
      (s.id = ANY(v_ids) AND NOT (h.target_scene_id = ANY(v_ids)))
      OR (s.space_id = p_source AND NOT (s.id = ANY(v_ids)) AND h.target_scene_id = ANY(v_ids))
    );
  GET DIAGNOSTICS v_links = ROW_COUNT;

  -- 4. Panorama uploads of the moved scenes (looked up before the scenes move).
  UPDATE property_media m SET property_id = v_new_id
  WHERE m.property_id = p_source
    AND m.media_type = 'panorama'
    AND m.public_url IN (
      SELECT raw_image_url FROM scenes WHERE id = ANY(v_ids) AND raw_image_url IS NOT NULL
      UNION
      SELECT original_raw_image_url FROM scenes WHERE id = ANY(v_ids) AND original_raw_image_url IS NOT NULL
    );
  GET DIAGNOSTICS v_panos = ROW_COUNT;

  -- 5. The scenes. The new tour is empty, so 0..n-1 can't collide on (space_id, order_index).
  WITH ordered AS (
    SELECT id, (row_number() OVER (ORDER BY order_index, id) - 1)::int AS idx
    FROM scenes WHERE id = ANY(v_ids)
  )
  UPDATE scenes s
  SET space_id = v_new_id, order_index = o.idx,
      floor_plan_id = NULL, plan_x = NULL, plan_y = NULL
  FROM ordered o
  WHERE s.id = o.id;
  GET DIAGNOSTICS v_scenes = ROW_COUNT;

  -- 6. Spotlights carry a space_id of their own (tables only exist after migration-spotlights.sql).
  IF to_regclass('public.scene_spotlights') IS NOT NULL THEN
    EXECUTE 'UPDATE scene_spotlights SET space_id = $1 WHERE scene_id = ANY($2)' USING v_new_id, v_ids;
  END IF;
  IF to_regclass('public.scene_spotlight_files') IS NOT NULL THEN
    EXECUTE 'UPDATE scene_spotlight_files SET space_id = $1 WHERE scene_id = ANY($2)' USING v_new_id, v_ids;
  END IF;

  -- 7. Chosen gallery photos.
  IF coalesce(array_length(v_photo_ids, 1), 0) > 0 THEN
    UPDATE property_media SET property_id = v_new_id WHERE id = ANY(v_photo_ids);
    GET DIAGNOSTICS v_photos = ROW_COUNT;
  END IF;

  -- 8. The source tour's flags (it may have lost its last panorama or photo).
  UPDATE properties SET
    has_360     = EXISTS (SELECT 1 FROM property_media WHERE property_id = p_source AND media_type = 'panorama'),
    has_gallery = EXISTS (SELECT 1 FROM property_media WHERE property_id = p_source AND media_type = 'gallery_image'),
    updated_at  = now()
  WHERE id = p_source;

  RETURN jsonb_build_object(
    'id', v_new_id,
    'slug', p_slug,
    'scenes', v_scenes,
    'photos', v_photos,
    'panoramas', v_panos,
    'links_removed', v_links
  );
END;
$$;

REVOKE ALL ON FUNCTION public.move_scenes_to_new_tour(UUID, UUID, UUID[], UUID[], TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_scenes_to_new_tour(UUID, UUID, UUID[], UUID[], TEXT, TEXT) TO service_role;
