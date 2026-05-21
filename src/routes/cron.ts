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

    // Find users created in the 7-day window who have no published spaces
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

    // Find which of those users have at least one published space
    const { data: publishedSpaces } = await fastify.supabase
      .from('spaces')
      .select('user_id')
      .in('user_id', userIds)
      .eq('status', 'published')

    const publishedUserIds = new Set((publishedSpaces || []).map(s => s.user_id))
    const unpublishedProfiles = profiles.filter(p => !publishedUserIds.has(p.id))

    if (!unpublishedProfiles.length) {
      fastify.log.info('cron/nudge: all users in window have published tours')
      return reply.send({ sent: 0 })
    }

    // Fetch emails from auth admin
    let sent = 0
    for (const profile of unpublishedProfiles) {
      try {
        const { data: authUser } = await fastify.supabase.auth.admin.getUserById(profile.id)
        const email = (authUser as any)?.user?.email as string | undefined
        if (!email) continue
        await sendNoPublishNudgeEmail({ ownerEmail: email, name: profile.full_name })
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
  // Sends a reminder to users whose plan expires in exactly 7 days
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

    let sent = 0
    for (const sub of subs) {
      try {
        const { data: authUser } = await fastify.supabase.auth.admin.getUserById(sub.user_id)
        const email = (authUser as any)?.user?.email as string | undefined
        const name = (authUser as any)?.user?.user_metadata?.full_name || null
        if (!email) continue

        const expiresAt = new Date(sub.current_period_end)
        const daysLeft = Math.round((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        const planName = (sub as any).plans?.name || 'Premium'

        await sendPlanExpiryReminderEmail({ ownerEmail: email, name, planName, expiresAt, daysLeft })
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
  // Sends each user a summary of leads received in the past 7 days
  fastify.post('/cron/weekly-digest', async (req, reply) => {
    if (!verifyCronSecret(req.headers['x-cron-secret'])) {
      return reply.code(401).send({ statusMessage: 'Unauthorized' })
    }

    const periodEnd = new Date()
    const periodStart = new Date()
    periodStart.setDate(periodStart.getDate() - 7)

    // Fetch leads with their space's owner info
    const { data: leads, error } = await fastify.supabase
      .from('leads')
      .select('name, email, spaces(user_id, name)')
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

    // Group leads by space owner
    const byOwner = new Map<string, Array<{ leadName: string; leadEmail: string; spaceName: string }>>()
    for (const lead of leads) {
      const space = (lead as any).spaces
      if (!space?.user_id) continue
      if (!byOwner.has(space.user_id)) byOwner.set(space.user_id, [])
      byOwner.get(space.user_id)!.push({
        leadName: lead.name,
        leadEmail: lead.email,
        spaceName: space.name || 'Unnamed tour',
      })
    }

    let sent = 0
    for (const [userId, userLeads] of byOwner) {
      try {
        const { data: authUser } = await fastify.supabase.auth.admin.getUserById(userId)
        const email = (authUser as any)?.user?.email as string | undefined
        const name = (authUser as any)?.user?.user_metadata?.full_name || null
        if (!email) continue

        await sendWeeklyLeadDigestEmail({ ownerEmail: email, name, leads: userLeads, periodStart, periodEnd })
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
  // Warns users who are at ≥80% of their plan's tour or storage quota
  fastify.post('/cron/limit-warning', async (req, reply) => {
    if (!verifyCronSecret(req.headers['x-cron-secret'])) {
      return reply.code(401).send({ statusMessage: 'Unauthorized' })
    }

    // Fetch all usage counters joined with subscriptions + plans
    const { data: rows, error } = await fastify.supabase
      .from('usage_counters')
      .select('user_id, active_properties_count, storage_used_bytes, subscriptions!inner(plan_id, status, plans!inner(name, max_active_properties, max_storage_bytes))')
      .in('subscriptions.status', ['active', 'trialing'])

    if (error) {
      fastify.log.error(error, 'cron/limit-warning: failed to query usage')
      return reply.code(500).send({ statusMessage: 'Query failed' })
    }

    if (!rows?.length) return reply.send({ sent: 0 })

    let sent = 0
    for (const row of rows) {
      try {
        const sub = (row as any).subscriptions
        const plan = sub?.plans
        if (!plan) continue

        const toursUsed: number = row.active_properties_count || 0
        const toursMax: number = plan.max_active_properties || 0
        const storageUsed: number = Number(row.storage_used_bytes || 0)
        const storageMax: number = Number(plan.max_storage_bytes || 0)

        const tourPct = toursMax > 0 ? (toursUsed / toursMax) : 0
        const storagePct = storageMax > 0 ? (storageUsed / storageMax) : 0

        if (tourPct < 0.8 && storagePct < 0.8) continue

        // Throttle: skip if warned in the last 7 days
        const warnKey = `limit_warn:${row.user_id}`
        if (fastify.redis) {
          const recent = await fastify.redis.get(warnKey).catch(() => null)
          if (recent) continue
        }

        const { data: authUser } = await fastify.supabase.auth.admin.getUserById(row.user_id)
        const email = (authUser as any)?.user?.email as string | undefined
        const name = (authUser as any)?.user?.user_metadata?.full_name || null
        if (!email) continue

        await sendLimitWarningEmail({
          ownerEmail: email, name,
          planName: plan.name,
          toursUsed, toursMax,
          storageUsedBytes: storageUsed, storageMaxBytes: storageMax,
        })

        if (fastify.redis) {
          await fastify.redis.set(warnKey, '1', { EX: 60 * 60 * 24 * 7 }).catch(() => {})
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
  // Schedule: 1st of each month at 08:00 UTC — `0 8 1 * *`
  // Sends each user their previous month's views + leads summary
  fastify.post('/cron/monthly-report', async (req, reply) => {
    if (!verifyCronSecret(req.headers['x-cron-secret'])) {
      return reply.code(401).send({ statusMessage: 'Unauthorized' })
    }

    // Previous calendar month
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)
    const monthLabel = monthStart.toLocaleDateString('en-KE', { month: 'long', year: 'numeric' })

    // Pull analytics_daily for the month, with property owner info
    const { data: analyticsRows, error: analyticsErr } = await fastify.supabase
      .from('analytics_daily')
      .select('property_id, total_views, properties!inner(user_id, title)')
      .gte('date', monthStart.toISOString().split('T')[0])
      .lte('date', monthEnd.toISOString().split('T')[0])

    if (analyticsErr) {
      fastify.log.error(analyticsErr, 'cron/monthly-report: analytics query failed')
      return reply.code(500).send({ statusMessage: 'Query failed' })
    }

    // Pull leads for the month
    const { data: leadRows, error: leadsErr } = await fastify.supabase
      .from('leads')
      .select('property_id, properties!inner(user_id)')
      .gte('created_at', monthStart.toISOString())
      .lte('created_at', monthEnd.toISOString())

    if (leadsErr) {
      fastify.log.error(leadsErr, 'cron/monthly-report: leads query failed')
      return reply.code(500).send({ statusMessage: 'Query failed' })
    }

    if (!analyticsRows?.length && !leadRows?.length) {
      fastify.log.info('cron/monthly-report: no activity this month')
      return reply.send({ sent: 0 })
    }

    // Aggregate by user → by property
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

    let sent = 0
    for (const [userId, tourMap] of byUser) {
      try {
        const { data: authUser } = await fastify.supabase.auth.admin.getUserById(userId)
        const email = (authUser as any)?.user?.email as string | undefined
        const name = (authUser as any)?.user?.user_metadata?.full_name || null
        if (!email) continue

        const tours = Array.from(tourMap.values()).sort((a, b) => b.views - a.views)
        const totalViews = tours.reduce((s, t) => s + t.views, 0)
        const totalLeads = tours.reduce((s, t) => s + t.leads, 0)

        await sendMonthlyReportEmail({ ownerEmail: email, name, monthLabel, totalViews, totalLeads, topTours: tours })
        sent++
      } catch (err) {
        fastify.log.error(err, `cron/monthly-report: failed for user ${userId}`)
      }
    }

    fastify.log.info({ sent, monthLabel }, 'cron/monthly-report: complete')
    return reply.send({ sent })
  })
}
