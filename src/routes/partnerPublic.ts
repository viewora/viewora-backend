import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

// Which sites may embed a tour. The app's /embed page reads this on the
// server and turns it into a CSP frame-ancestors rule.
//   { frame_ancestors: null }          → no restriction (every non-partner tour)
//   { frame_ancestors: ["https://…"] } → only these sites (plus Viewora itself)

const params = z.object({ slug: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/) })
const TTL = 300

export async function lookupEmbedOrigins(fastify: FastifyInstance, slug: string): Promise<string[] | null> {
  const db = fastify.supabase
  const { data: space } = await db.from('properties').select('id').eq('slug', slug).maybeSingle()
  if (!space) return null
  const { data: ref } = await db.from('api_partner_tours')
    .select('api_partners(status, allowed_embed_origins)')
    .eq('space_id', space.id).maybeSingle()
  const partner = (ref as any)?.api_partners
  const origins: string[] = partner?.allowed_embed_origins ?? []
  return origins.length ? origins : null
}

export default async function partnerPublic(fastify: FastifyInstance) {
  fastify.get('/embed-policy/:slug', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: (r: any) => r.ip } },
  }, async (request, reply) => {
    const p = params.safeParse(request.params)
    if (!p.success) return reply.code(400).send({ statusMessage: 'Invalid slug' })
    const key = `embedpolicy:${p.data.slug}`
    const redis = (fastify as any).redis

    let origins: string[] | null | undefined
    if (redis) {
      const hit = await redis.get(key).catch(() => null)
      if (hit) origins = JSON.parse(hit)
    }
    if (origins === undefined) {
      try {
        origins = await lookupEmbedOrigins(fastify, p.data.slug)
      } catch (err: any) {
        request.log.warn({ err: err?.message }, 'embed policy lookup failed')
        return reply.code(503).send({ statusMessage: 'Embed policy unavailable' })
      }
      if (redis) await redis.setEx(key, TTL, JSON.stringify(origins)).catch(() => {})
    }
    reply.header('Cache-Control', `public, max-age=${TTL}`)
    return reply.send({ frame_ancestors: origins })
  })
}
