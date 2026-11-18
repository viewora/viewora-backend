// Tripod cover: the owner's logo under the camera in every scene
// (property_360_settings.nadir_cover, migration-nadir-cover.sql).
// The app draws it (viewora-app shared/utils/viewerAdapters/nadirCover.ts);
// the server only validates and serves the settings.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

export const nadirCoverSchema = z.object({
  enabled: z.boolean(),
  // all: every scene except hidden_scene_ids. some: only scene_ids. Absent = all.
  mode: z.enum(['all', 'some']).optional(),
  scene_ids: z.array(z.string().uuid()).max(1000).optional(),
  url: z.string().url().max(2048).refine(u => /^https:\/\//i.test(u), { message: 'URL must use https' }),
  size: z.number().min(8).max(40),
  rotation: z.number().min(-180).max(180),
  fit: z.enum(['fill', 'fit']),
  bg: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  hidden_scene_ids: z.array(z.string().uuid()).max(1000),
}).strict()

export type NadirCover = z.infer<typeof nadirCoverSchema>

/**
 * A tour's tripod cover, read fresh (not part of get_tour_data's cached blob).
 * undefined when it can't be read, e.g. before the migration has run: callers
 * then leave the field out and the tour shows no cover.
 */
export async function readNadirCover(fastify: FastifyInstance, spaceId: string): Promise<NadirCover | null | undefined> {
  const { data, error } = await fastify.supabase
    .from('property_360_settings')
    .select('nadir_cover')
    .eq('property_id', spaceId)
    .maybeSingle()
  if (error) return undefined
  return ((data as any)?.nadir_cover ?? null) as NadirCover | null
}

/** Put the cover on a space's property_360_settings[0] (creating the entry if needed). */
export function attachNadirCover(space: any, cover: NadirCover | null | undefined): void {
  if (!space || cover === undefined) return
  const list = Array.isArray(space.property_360_settings) ? space.property_360_settings : []
  space.property_360_settings = list.length
    ? [{ ...list[0], nadir_cover: cover }, ...list.slice(1)]
    : [{ nadir_cover: cover }]
}
