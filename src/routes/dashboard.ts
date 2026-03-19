import { FastifyInstance } from 'fastify'
import { checkUserQuota } from '../utils/quotas.js'

export default async function (fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)

  fastify.get('/summary', async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    // 1. Get user plan capabilities
    const { plan } = await checkUserQuota(fastify, userId)

    // 2. Spaces
    const { data: spaces } = await fastify.supabase
      .from('properties')
      .select('id, is_published')
      .eq('user_id', userId)

    const totalSpaces = spaces?.length ?? 0
    const publishedSpaces = spaces?.filter((p) => p.is_published).length ?? 0
    const spaceIds = (spaces ?? []).map((p) => p.id)

    // 3. Leads (if entitled)
    let newLeads7d: number | null = null
    if (plan.lead_capture_enabled && spaceIds.length > 0) {
      const { count } = await fastify.supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .in('property_id', spaceIds)
        .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

      newLeads7d = count ?? 0
    } else if (plan.lead_capture_enabled) {
      newLeads7d = 0
    }

    // 4. Analytics total views
    let totalViews = 0
    if (spaceIds.length > 0) {
      const { data: analytics } = await fastify.supabase
        .from('analytics_daily')
        .select('total_views')
        .in('property_id', spaceIds)

      totalViews = (analytics ?? []).reduce((sum: number, row: any) => sum + (row.total_views ?? 0), 0)
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
