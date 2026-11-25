-- Migration: copy or move scenes (and chosen gallery photos) into ANOTHER EXISTING tour.
-- Run in Supabase Dashboard > SQL Editor > New query. Rollback: migration-add-scenes-to-tour.down.sql
--
-- Used by POST /spaces/:id/add-scenes-to-tour (routes/spaces.ts). One function, one
-- transaction: either every chosen scene and photo is in the other tour, or nothing changed.
-- Companion of migration-move-scenes.sql (which makes a NEW tour).
--
-- Both tours must belong to p_user. The target tour keeps its own details and viewer
-- settings; the scenes are added after its last scene, in their current order.
--
-- p_copy = false (MOVE): same as move_scenes_to_new_tour, into an existing tour —
--   scenes change space_id with their hotspots, info points and spotlights; arrows that
--   would cross between the two tours are removed; floor-plan pins are cleared; each
--   scene's panorama upload row and the chosen photos move too.
--
-- p_copy = true (COPY, e.g. common areas both units share): the scenes STAY here and the
--   other tour gets copies with new ids. Copied with them: their info points and the
--   arrows between the chosen scenes (arrows to scenes that were not chosen are left out).
--   Not copied: spotlights, floor-plan pins. Files are NOT copied — the copies point at the
--   same R2 files, and the delete routes check utils/sceneStorage.ts filesStillUsed()
--   before removing a file another scene still shows. The panorama upload row stays with
--   the original (storage is counted once). Chosen photos get a copy row in the other tour
--   pointing at the same file.
--
-- Callable by the service role only (it trusts p_user).

CREATE OR REPLACE FUNCTION public.add_scenes_to_tour(
  p_user      UUID,
  p_source    UUID,
  p_target    UUID,
  p_scene_ids UUID[],
  p_photo_ids UUID[],
  p_copy      BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids       UUID[] := ARRAY(SELECT DISTINCT unnest(p_scene_ids));
  v_photo_ids UUID[] := ARRAY(SELECT DISTINCT unnest(coalesce(p_photo_ids, '{}'::uuid[])));
  v_offset    INT;
  v_photo_off INT;
  v_cols      TEXT;
  v_rows      JSONB;
  v_scenes    INT := 0;
  v_photos    INT := 0;
  v_links     INT := 0;
  v_hotspots  INT := 0;
  v_new_ids   UUID[] := '{}';  -- the scenes as they are now in the target tour, in order
  v_err_msg   TEXT;
  v_err_ctx   TEXT;
  v_err_state TEXT;
BEGIN
  IF p_source = p_target THEN
    RAISE EXCEPTION 'ADD_SAME_TOUR' USING ERRCODE = 'P0001';
  END IF;
  -- Lock both tours in a fixed order so two opposite operations can't deadlock.
  PERFORM 1 FROM properties WHERE id IN (p_source, p_target) ORDER BY id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM properties WHERE id = p_source AND user_id = p_user) THEN
    RAISE EXCEPTION 'MOVE_SOURCE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM properties WHERE id = p_target AND user_id = p_user) THEN
    RAISE EXCEPTION 'ADD_TARGET_NOT_FOUND' USING ERRCODE = 'P0001';
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

  -- After the target's last scene: (space_id, order_index) is unique, so no collisions.
  SELECT coalesce(max(order_index) + 1, 0) INTO v_offset FROM scenes WHERE space_id = p_target;
  SELECT coalesce(max(sort_order) + 1, 0) INTO v_photo_off
  FROM property_media WHERE property_id = p_target AND media_type = 'gallery_image';

  IF NOT p_copy THEN
    -- ── MOVE ──────────────────────────────────────────────────────────
    DELETE FROM hotspots h
    USING scenes s
    WHERE h.scene_id = s.id
      AND h.target_scene_id IS NOT NULL
      AND (
        (s.id = ANY(v_ids) AND NOT (h.target_scene_id = ANY(v_ids)))
        OR (s.space_id = p_source AND NOT (s.id = ANY(v_ids)) AND h.target_scene_id = ANY(v_ids))
      );
    GET DIAGNOSTICS v_links = ROW_COUNT;

    UPDATE property_media m SET property_id = p_target
    WHERE m.property_id = p_source
      AND m.media_type = 'panorama'
      AND m.public_url IN (
        SELECT raw_image_url FROM scenes WHERE id = ANY(v_ids) AND raw_image_url IS NOT NULL
        UNION
        SELECT original_raw_image_url FROM scenes WHERE id = ANY(v_ids) AND original_raw_image_url IS NOT NULL
      );

    WITH ordered AS (
      SELECT id, (v_offset + row_number() OVER (ORDER BY order_index, id) - 1)::int AS idx
      FROM scenes WHERE id = ANY(v_ids)
    )
    UPDATE scenes s
    SET space_id = p_target, order_index = o.idx,
        floor_plan_id = NULL, plan_x = NULL, plan_y = NULL
    FROM ordered o
    WHERE s.id = o.id;
    GET DIAGNOSTICS v_scenes = ROW_COUNT;
    v_new_ids := ARRAY(SELECT id FROM scenes WHERE id = ANY(v_ids) ORDER BY order_index);

    IF to_regclass('public.scene_spotlights') IS NOT NULL THEN
      EXECUTE 'UPDATE scene_spotlights SET space_id = $1 WHERE scene_id = ANY($2)' USING p_target, v_ids;
    END IF;
    IF to_regclass('public.scene_spotlight_files') IS NOT NULL THEN
      EXECUTE 'UPDATE scene_spotlight_files SET space_id = $1 WHERE scene_id = ANY($2)' USING p_target, v_ids;
    END IF;

    IF coalesce(array_length(v_photo_ids, 1), 0) > 0 THEN
      WITH ordered AS (
        SELECT id, (v_photo_off + row_number() OVER (ORDER BY sort_order, id) - 1)::int AS idx
        FROM property_media WHERE id = ANY(v_photo_ids)
      )
      UPDATE property_media m SET property_id = p_target, sort_order = o.idx, is_primary = false
      FROM ordered o WHERE m.id = o.id;
      GET DIAGNOSTICS v_photos = ROW_COUNT;
    END IF;

  ELSE
    -- ── COPY ──────────────────────────────────────────────────────────
    CREATE TEMP TABLE IF NOT EXISTS _scene_copy_map (old_id UUID PRIMARY KEY, new_id UUID NOT NULL, idx INT NOT NULL) ON COMMIT DROP;
    -- WHERE true: Supabase's API loads pg-safeupdate, which rejects a DELETE without WHERE (error 21000).
    DELETE FROM _scene_copy_map WHERE true;
    INSERT INTO _scene_copy_map (old_id, new_id, idx)
    SELECT id, gen_random_uuid(), (v_offset + row_number() OVER (ORDER BY order_index, id) - 1)::int
    FROM scenes WHERE id = ANY(v_ids);
    v_new_ids := ARRAY(SELECT new_id FROM _scene_copy_map ORDER BY idx);

    -- Scenes: every column copied generically (columns added later come along too).
    SELECT jsonb_agg(to_jsonb(s) || jsonb_build_object(
      'id',            m.new_id,
      'space_id',      p_target,
      'order_index',   m.idx,
      'floor_plan_id', NULL,
      'plan_x',        NULL,
      'plan_y',        NULL,
      'created_at',    now(),
      'updated_at',    now()
    )) INTO v_rows
    FROM scenes s JOIN _scene_copy_map m ON m.old_id = s.id;

    SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'scenes'
      AND is_generated = 'NEVER' AND is_identity = 'NO';
    EXECUTE format('INSERT INTO scenes (%1$s) SELECT %1$s FROM jsonb_populate_recordset(NULL::scenes, $1)', v_cols)
      USING v_rows;
    GET DIAGNOSTICS v_scenes = ROW_COUNT;

    -- Hotspots: info points / links / media, plus arrows whose target was copied too.
    SELECT jsonb_agg(to_jsonb(h) || jsonb_build_object(
      'id',              gen_random_uuid(),
      'scene_id',        m.new_id,
      'target_scene_id', t.new_id
    )) INTO v_rows
    FROM hotspots h
    JOIN _scene_copy_map m ON m.old_id = h.scene_id
    LEFT JOIN _scene_copy_map t ON t.old_id = h.target_scene_id
    WHERE h.target_scene_id IS NULL OR t.new_id IS NOT NULL;

    IF v_rows IS NOT NULL THEN
      SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'hotspots'
        AND is_generated = 'NEVER' AND is_identity = 'NO';
      EXECUTE format('INSERT INTO hotspots (%1$s) SELECT %1$s FROM jsonb_populate_recordset(NULL::hotspots, $1)', v_cols)
        USING v_rows;
      GET DIAGNOSTICS v_hotspots = ROW_COUNT;
    END IF;
    -- Arrows left out because their target stayed behind.
    SELECT count(*) INTO v_links FROM hotspots
    WHERE scene_id = ANY(v_ids) AND target_scene_id IS NOT NULL AND NOT (target_scene_id = ANY(v_ids));

    -- Photos: a copy row in the target, same file.
    IF coalesce(array_length(v_photo_ids, 1), 0) > 0 THEN
      SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object(
        'id',          gen_random_uuid(),
        'property_id', p_target,
        'sort_order',  v_photo_off + o.rn - 1,
        'is_primary',  false,
        'file_size_bytes', 0,  -- same file: storage stays counted once, on the original row
        'created_at',  now(),
        'updated_at',  now()
      )) INTO v_rows
      FROM property_media p
      JOIN (SELECT id, row_number() OVER (ORDER BY sort_order, id) AS rn FROM property_media WHERE id = ANY(v_photo_ids)) o
        ON o.id = p.id;

      SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'property_media'
        AND is_generated = 'NEVER' AND is_identity = 'NO';
      EXECUTE format('INSERT INTO property_media (%1$s) SELECT %1$s FROM jsonb_populate_recordset(NULL::property_media, $1)', v_cols)
        USING v_rows;
      GET DIAGNOSTICS v_photos = ROW_COUNT;
    END IF;
  END IF;

  -- Flags on both tours.
  UPDATE properties SET
    has_360     = has_360 OR v_scenes > 0,
    has_gallery = has_gallery OR v_photos > 0,
    updated_at  = now()
  WHERE id = p_target;
  IF NOT p_copy THEN
    UPDATE properties SET
      has_360     = EXISTS (SELECT 1 FROM property_media WHERE property_id = p_source AND media_type = 'panorama'),
      has_gallery = EXISTS (SELECT 1 FROM property_media WHERE property_id = p_source AND media_type = 'gallery_image'),
      updated_at  = now()
    WHERE id = p_source;
  END IF;

  RETURN jsonb_build_object(
    'scenes', v_scenes,
    'photos', v_photos,
    'hotspots', v_hotspots,
    'links_removed', v_links,
    'copied', p_copy,
    'scene_ids', to_jsonb(v_new_ids)
  );
EXCEPTION WHEN OTHERS THEN
  -- Same error, plus WHERE it happened in DETAIL (the API only passes message/details/hint
  -- through, and our logs show details). Everything above is rolled back either way.
  GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT, v_err_ctx = PG_EXCEPTION_CONTEXT, v_err_state = RETURNED_SQLSTATE;
  RAISE EXCEPTION USING ERRCODE = v_err_state, MESSAGE = v_err_msg, DETAIL = left(v_err_ctx, 900);
END;
$$;

REVOKE ALL ON FUNCTION public.add_scenes_to_tour(UUID, UUID, UUID, UUID[], UUID[], BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_scenes_to_tour(UUID, UUID, UUID, UUID[], UUID[], BOOLEAN) TO service_role;

-- Which of these R2 folders / object keys does some scene or upload row still use?
-- The delete routes (scene, tour, photo) ask before removing files, because copies made
-- by add_scenes_to_tour share files with their originals. strpos, not LIKE: keys contain "_".
CREATE OR REPLACE FUNCTION public.files_still_used(
  p_prefixes   TEXT[],
  p_keys       TEXT[],
  p_skip_media UUID[] DEFAULT '{}'
) RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(array_agg(x), '{}') FROM (
    SELECT p AS x FROM unnest(coalesce(p_prefixes, '{}')) p
    WHERE p <> '' AND EXISTS (
      SELECT 1 FROM scenes s
      WHERE strpos(coalesce(s.thumbnail_url, ''), p) > 0
         OR strpos(coalesce(s.tile_manifest_url, ''), p) > 0
         OR strpos(coalesce(s.tile_medium_manifest_url, ''), p) > 0
         OR strpos(coalesce(s.raw_image_url, ''), p) > 0
    )
    UNION
    SELECT k FROM unnest(coalesce(p_keys, '{}')) k
    WHERE k <> '' AND (
      EXISTS (
        SELECT 1 FROM scenes s
        WHERE strpos(coalesce(s.raw_image_url, ''), k) > 0
           OR strpos(coalesce(s.original_raw_image_url, ''), k) > 0
      )
      OR EXISTS (
        SELECT 1 FROM property_media m
        WHERE m.storage_key = k AND NOT (m.id = ANY(coalesce(p_skip_media, '{}')))
      )
    )
  ) used;
$$;

REVOKE ALL ON FUNCTION public.files_still_used(TEXT[], TEXT[], UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.files_still_used(TEXT[], TEXT[], UUID[]) TO service_role;
