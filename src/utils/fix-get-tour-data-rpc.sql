-- Updates get_tour_data to include tile fields needed by the PSV tiled adapter.
-- Without tile_cols/tile_rows/tiles_ready/width/height the public viewer always
-- falls back to the raw panorama instead of using the tiled format.
CREATE OR REPLACE FUNCTION public.get_tour_data(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_space_id UUID;
  v_result   JSONB;
BEGIN
  SELECT id INTO v_space_id
  FROM properties
  WHERE (slug = p_slug OR id::text = p_slug)
    AND is_published = true
    AND visibility = 'public';

  IF v_space_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'space', (
      SELECT row_to_json(p_row.*) FROM (
        SELECT
          p.*,
          (SELECT jsonb_agg(s360.*) FROM property_360_settings s360 WHERE s360.property_id = p.id) as property_360_settings
        FROM properties p
        WHERE p.id = v_space_id
      ) p_row
    ),
    'scenes', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id',               s.id,
          'name',             s.name,
          'order_index',      s.order_index,
          'raw_image_url',    s.raw_image_url,
          'tile_manifest_url',s.tile_manifest_url,
          'tile_cols',        s.tile_cols,
          'tile_rows',        s.tile_rows,
          'tiles_ready',      s.tiles_ready,
          'width',            s.width,
          'height',           s.height,
          'thumbnail_url',    s.thumbnail_url,
          'status',           s.status,
          'initial_yaw',      s.initial_yaw,
          'initial_pitch',    s.initial_pitch,
          'hotspots', (
            SELECT jsonb_agg(row_to_json(h.*) ORDER BY h.created_at ASC)
            FROM hotspots h
            WHERE h.scene_id = s.id
          )
        ) ORDER BY s.order_index ASC
      )
      FROM scenes s
      WHERE s.space_id = v_space_id
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;
