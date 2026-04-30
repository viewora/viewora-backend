import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { checkUserQuota } from '../utils/quotas.js'
import { parseWithSchema } from '../utils/validation.js'

const emptyQuerySchema = z.object({}).passthrough()

export default async function (fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)

  fastify.get('/summary', async (request, reply) => {
    const query = parseWithSchema(reply, emptyQuerySchema, request.query)
    if (!query) return

    const user = request.user as any
    const userId = user.sub

    // Batch 1: plan + spaces in parallel
    const [{ plan }, { data: spaces }] = await Promise.all([
      checkUserQuota(fastify, userId),
      fastify.supabase.from('properties').select('id, is_published').eq('user_id', userId),
    ])

    const totalSpaces = spaces?.length ?? 0
    const publishedSpaces = spaces?.filter((p) => p.is_published).length ?? 0
    const spaceIds = (spaces ?? []).map((p) => p.id)
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    // Batch 2: leads + analytics in parallel (only if there are spaces)
    let newLeads7d: number | null = null
    let totalViews = 0

    if (spaceIds.length > 0) {
      const [leadsResult, analyticsResult] = await Promise.all([
        plan.lead_capture_enabled
          ? fastify.supabase.from('leads').select('id', { count: 'exact', head: true }).in('property_id', spaceIds).gte('created_at', since7d)
          : Promise.resolve({ count: null }),
        fastify.supabase.from('analytics_daily').select('total_views').in('property_id', spaceIds),
      ])

      if (plan.lead_capture_enabled) newLeads7d = leadsResult.count ?? 0
      totalViews = ((analyticsResult as any).data ?? []).reduce((sum: number, row: any) => sum + (row.total_views ?? 0), 0)
    } else if (plan.lead_capture_enabled) {
      newLeads7d = 0
    }

    return reply.send({
      total_spaces: totalSpaces,
      published_spaces: publishedSpaces,
      new_leads_7d: newLeads7d,
      lead_capture_enabled: plan.lead_capture_enabled,
      total_views: totalViews,
      plan_name: plan.name,
    })
  })
}
