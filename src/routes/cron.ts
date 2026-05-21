import { FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'crypto'
import {
  sendNoPublishNudgeEmail,
  sendPlanExpiryReminderEmail,
  sendWeeklyLeadDigestEmail,
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
}
