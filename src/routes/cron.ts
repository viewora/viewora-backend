import { FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'crypto'
import {
  sendNoPublishNudgeEmail,
  sendPlanExpiryReminderEmail,
  sendWeeklyLeadDigestEmail,
  sendLimitWarningEmail,
  sendMonthlyReportEmail,
} from '../email/index.js'

function verifyCronSecret(secret: string | string[] | undefined): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  const incoming = Array.isArray(secret) ? secret[0] : secret
  if (!incoming || incoming.length !== cronSecret.length) return false
  try {
    return timingSafeEqual(Buffer.from(incoming), Buffer.from(cronSecret))
  } catch {
    return false
  }
}

/** Single RPC replaces N sequential getUserById calls */
async function batchGetUsers(
  fastify: FastifyInstance,
  userIds: string[],
): Promise<Map<string, { email: string; name: string | null }>> {
  if (!userIds.length) return new Map()
  const { data, error } = await fastify.supabase.rpc('get_users_by_ids', { user_ids: userIds })
  if (error) {
    fastify.log.error({ error: error.message }, 'batchGetUsers RPC failed')
    return new Map()
  }
  return new Map(
    (data as Array<{ id: string; email: string; full_name: string | null }>)
      .map(u => [u.id, { email: u.email, name: u.full_name ?? null }])
  )
}

export default async function cronRoutes(fastify: FastifyInstance) {

  // POST /cron/nudge
  // Schedule: daily at 09:00 UTC
  // Sends a nudge to users who signed up 7 days ago with no published tours
  fastify.post('/cron/nudge', async (req, reply) => {
    if (!verifyCronSecret(req.headers['x-cron-secret'])) {
      return reply.code(401).send({ statusMessage: 'Unauthorized' })
    }

    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    const eightDaysAgo = new Date()
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8)

    const { data: profiles, error } = await fastify.supabase
      .from('profiles')
      .select('id, full_name')
      .gte('created_at', eightDaysAgo.toISOString())
      .lte('created_at', sevenDaysAgo.toISOString())

    if (error) {
      fastify.log.error(error, 'cron/nudge: failed to query profiles')
      return reply.code(500).send({ statusMessage: 'Query failed' })
    }

    if (!profiles?.length) {
      fastify.log.info('cron/nudge: no users in window')
      return reply.send({ sent: 0 })
    }

    const userIds = profiles.map(p => p.id)

    const { data: publishedSpaces } = await fastify.supabase
      .from('properties')
      .select('user_id')
      .in('user_id', userIds)
      .eq('is_published', true)

    const publishedUserIds = new Set((publishedSpaces || []).map(s => s.user_id))
    const unpublishedProfiles = profiles.filter(p => !publishedUserIds.has(p.id))

    if (!unpublishedProfiles.length) {
      fastify.log.info('cron/nudge: all users in window have published tours')
      return reply.send({ sent: 0 })
    }

    const userMap = await batchGetUsers(fastify, unpublishedProfiles.map(p => p.id))

    let sent = 0
    for (const profile of unpublishedProfiles) {
      try {
        const user = userMap.get(profile.id)
        if (!user?.email) continue
        await sendNoPublishNudgeEmail({ ownerEmail: user.email, name: profile.full_name })
        sent++
      } catch (err) {
        fastify.log.error(err, `cron/nudge: failed for user ${profile.id}`)
      }
    }

    fastify.log.info({ sent }, 'cron/nudge: complete')
    return reply.send({ sent })
  })

  // POST /cron/expiry-reminder
  // Schedule: daily at 09:00 UTC
  fastify.post('/cron/expiry-reminder', async (req, reply) => {
    if (!verifyCronSecret(req.headers['x-cron-secret'])) {
      return reply.code(401).send({ statusMessage: 'Unauthorized' })
    }

    const windowStart = new Date()
    windowStart.setDate(windowStart.getDate() + 6)
    const windowEnd = new Date()
    windowEnd.setDate(windowEnd.getDate() + 8)

    const { data: subs, error } = await fastify.supabase
      .from('subscriptions')
      .select('user_id, current_period_end, plans(name)')
      .eq('status', 'active')
      .gte('current_period_end', windowStart.toISOString())
      .lte('current_period_end', windowEnd.toISOString())

    if (error) {
      fastify.log.error(error, 'cron/expiry-reminder: failed to query subscriptions')
      return reply.code(500).send({ statusMessage: 'Query failed' })
    }

    if (!subs?.length) {
      fastify.log.info('cron/expiry-reminder: no expiring subscriptions')
      return reply.send({ sent: 0 })
    }

    const userMap = await batchGetUsers(fastify, subs.map(s => s.user_id))

    let sent = 0
    for (const sub of subs) {
      try {
        const user = userMap.get(sub.user_id)
        if (!user?.email) continue

        const expiresAt = new Date(sub.current_period_end)
        const daysLeft = Math.round((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        const planName = (sub as any).plans?.name || 'Premium'

        await sendPlanExpiryReminderEmail({ ownerEmail: user.email, name: user.name, planName, expiresAt, daysLeft })
        sent++
      } catch (err) {
        fastify.log.error(err, `cron/expiry-reminder: failed for user ${sub.user_id}`)
      }
    }

    fastify.log.info({ sent }, 'cron/expiry-reminder: complete')
    return reply.send({ sent })
  })

  // POST /cron/weekly-digest
  // Schedule: every Monday at 08:00 UTC
  fastify.post('/cron/weekly-digest', async (req, reply) => {
    if (!verifyCronSecret(req.headers['x-cron-secret'])) {
      return reply.code(401).send({ statusMessage: 'Unauthorized' })
    }

    const periodEnd = new Date()
    const periodStart = new Date()
    periodStart.setDate(periodStart.getDate() - 7)

    const { data: leads, error } = await fastify.supabase
      .from('leads')
      .select('name, email, properties!property_id(user_id, title)')
      .gte('created_at', periodStart.toISOString())
      .lte('created_at', periodEnd.toISOString())

    if (error) {
      fastify.log.error(error, 'cron/weekly-digest: failed to query leads')
      return reply.code(500).send({ statusMessage: 'Query failed' })
    }

    if (!leads?.length) {
      fastify.log.info('cron/weekly-digest: no leads this week')
      return reply.send({ sent: 0 })
    }

    const byOwner = new Map<string, Array<{ leadName: string; leadEmail: string; spaceName: string }>>()
    for (const lead of leads) {
      const space = (lead as any).properties
      if (!space?.user_id) continue
      if (!byOwner.has(space.user_id)) byOwner.set(space.user_id, [])
      byOwner.get(space.user_id)!.push({
        leadName: lead.name,
        leadEmail: lead.email,
        spaceName: space.title || 'Unnamed tour',
      })
    }

    const userMap = await batchGetUsers(fastify, Array.from(byOwner.keys()))

    let sent = 0
    for (const [userId, userLeads] of byOwner) {
      try {
        const user = userMap.get(userId)
        if (!user?.email) continue
        await sendWeeklyLeadDigestEmail({ ownerEmail: user.email, name: user.name, leads: userLeads, periodStart, periodEnd })
        sent++
      } catch (err) {
        fastify.log.error(err, `cron/weekly-digest: failed for user ${userId}`)
      }
    }

    fastify.log.info({ sent }, 'cron/weekly-digest: complete')
    return reply.send({ sent })
  })

  // POST /cron/limit-warning
  // Schedule: daily at 10:00 UTC
  fastify.post('/cron/limit-warning', async (req, reply) => {
    if (!verifyCronSecret(req.headers['x-cron-secret'])) {
      return reply.code(401).send({ statusMessage: 'Unauthorized' })
    }

    const { data: rows, error } = await fastify.supabase
      .from('usage_counters')
      .select('user_id, active_properties_count, storage_used_bytes, subscriptions!inner(plan_id, status, plans!inner(name, max_active_properties, max_storage_bytes))')
      .in('subscriptions.status', ['active', 'trialing'])

    if (error) {
      fastify.log.error(error, 'cron/limit-warning: failed to query usage')
      return reply.code(500).send({ statusMessage: 'Query failed' })
    }

    if (!rows?.length) return reply.send({ sent: 0 })

    // Filter to users at ≥80% capacity and not recently warned before fetching emails
    const eligible: typeof rows = []
    for (const row of rows) {
      const sub = (row as any).subscriptions
      const plan = sub?.plans
      if (!plan) continue

      const tourPct = plan.max_active_properties > 0 ? (row.active_properties_count || 0) / plan.max_active_properties : 0
      const storagePct = Number(plan.max_storage_bytes) > 0 ? Number(row.storage_used_bytes || 0) / Number(plan.max_storage_bytes) : 0
      if (tourPct < 0.8 && storagePct < 0.8) continue

      if (fastify.redis) {
        const recent = await fastify.redis.get(`limit_warn:${row.user_id}`).catch(() => null)
        if (recent) continue
      }
      eligible.push(row)
    }

    if (!eligible.length) return reply.send({ sent: 0 })

    const userMap = await batchGetUsers(fastify, eligible.map(r => r.user_id))

    let sent = 0
    for (const row of eligible) {
      try {
        const user = userMap.get(row.user_id)
        if (!user?.email) continue

        const sub = (row as any).subscriptions
        const plan = sub?.plans
        const toursUsed: number = row.active_properties_count || 0
        const toursMax: number = plan.max_active_properties || 0
        const storageUsed: number = Number(row.storage_used_bytes || 0)
        const storageMax: number = Number(plan.max_storage_bytes || 0)

        await sendLimitWarningEmail({
          ownerEmail: user.email, name: user.name,
          planName: plan.name,
          toursUsed, toursMax,
          storageUsedBytes: storageUsed, storageMaxBytes: storageMax,
        })

        if (fastify.redis) {
          await fastify.redis.set(`limit_warn:${row.user_id}`, '1', { EX: 60 * 60 * 24 * 7 }).catch(() => {})
        }
        sent++
      } catch (err) {
        fastify.log.error(err, `cron/limit-warning: failed for user ${row.user_id}`)
      }
    }

    fastify.log.info({ sent }, 'cron/limit-warning: complete')
    return reply.send({ sent })
  })

  // POST /cron/monthly-report
  // Schedule: 1st of each month at 08:00 UTC
  fastify.post('/cron/monthly-report', async (req, reply) => {
    if (!verifyCronSecret(req.headers['x-cron-secret'])) {
      return reply.code(401).send({ statusMessage: 'Unauthorized' })
    }

    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)
    const monthLabel = monthStart.toLocaleDateString('en-KE', { month: 'long', year: 'numeric' })

    const [{ data: analyticsRows, error: analyticsErr }, { data: leadRows, error: leadsErr }] = await Promise.all([
      fastify.supabase
        .from('analytics_daily')
        .select('property_id, total_views, properties!inner(user_id, title)')
        .gte('date', monthStart.toISOString().split('T')[0])
        .lte('date', monthEnd.toISOString().split('T')[0]),
      fastify.supabase
        .from('leads')
        .select('property_id, properties!inner(user_id)')
        .gte('created_at', monthStart.toISOString())
        .lte('created_at', monthEnd.toISOString()),
    ])

    if (analyticsErr) {
      fastify.log.error(analyticsErr, 'cron/monthly-report: analytics query failed')
      return reply.code(500).send({ statusMessage: 'Query failed' })
    }
    if (leadsErr) {
      fastify.log.error(leadsErr, 'cron/monthly-report: leads query failed')
      return reply.code(500).send({ statusMessage: 'Query failed' })
    }

    if (!analyticsRows?.length && !leadRows?.length) {
      fastify.log.info('cron/monthly-report: no activity this month')
      return reply.send({ sent: 0 })
    }

    type TourAgg = { name: string; views: number; leads: number }
    const byUser = new Map<string, Map<string, TourAgg>>()

    for (const row of analyticsRows || []) {
      const prop = (row as any).properties
      if (!prop?.user_id) continue
      if (!byUser.has(prop.user_id)) byUser.set(prop.user_id, new Map())
      const tourMap = byUser.get(prop.user_id)!
      const existing = tourMap.get(row.property_id) || { name: prop.title || 'Unnamed tour', views: 0, leads: 0 }
      existing.views += row.total_views || 0
      tourMap.set(row.property_id, existing)
    }

    for (const row of leadRows || []) {
      const prop = (row as any).properties
      if (!prop?.user_id) continue
      if (!byUser.has(prop.user_id)) byUser.set(prop.user_id, new Map())
      const tourMap = byUser.get(prop.user_id)!
      const existing = tourMap.get(row.property_id) || { name: 'Unnamed tour', views: 0, leads: 0 }
      existing.leads += 1
      tourMap.set(row.property_id, existing)
    }

    const userMap = await batchGetUsers(fastify, Array.from(byUser.keys()))

    let sent = 0
    for (const [userId, tourMap] of byUser) {
      try {
        const user = userMap.get(userId)
        if (!user?.email) continue

        const tours = Array.from(tourMap.values()).sort((a, b) => b.views - a.views)
        const totalViews = tours.reduce((s, t) => s + t.views, 0)
        const totalLeads = tours.reduce((s, t) => s + t.leads, 0)

        await sendMonthlyReportEmail({ ownerEmail: user.email, name: user.name, monthLabel, totalViews, totalLeads, topTours: tours })
        sent++
      } catch (err) {
        fastify.log.error(err, `cron/monthly-report: failed for user ${userId}`)
      }
    }

    fastify.log.info({ sent, monthLabel }, 'cron/monthly-report: complete')
    return reply.send({ sent })
  })
}
