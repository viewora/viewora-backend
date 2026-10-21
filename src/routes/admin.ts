import { FastifyInstance } from 'fastify'
import { randomUUID, timingSafeEqual } from 'crypto'
import { getCleanupDashboardState } from '../utils/metrics.js'
import { sendWelcomeEmail } from '../email/index.js'
import { DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'

// ── Auth middleware ────────────────────────────────────────────────────────────
async function requireAdmin(fastify: FastifyInstance, request: any, reply: any) {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return reply.code(401).send({ statusMessage: 'Admin secret not configured' })
  const authHeader = request.headers.authorization
  const expected = `Bearer ${adminSecret}`
  let authorized = false
  try {
    if (authHeader && authHeader.length === expected.length) {
      authorized = timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
    }
  } catch { authorized = false }
  if (!authorized) return reply.code(401).send({ statusMessage: 'Unauthorized' })
}

// ── Audit log helper ──────────────────────────────────────────────────────────
async function auditLog(
  fastify: FastifyInstance,
  request: any,
  action: string,
  resourceType: string,
  resourceId: string,
  payload?: Record<string, unknown>,
) {
  const adminId = request.headers['x-admin-id'] as string | undefined
  if (!adminId) return
  await fastify.supabase.from('admin_audit_log').insert({
    admin_id: adminId,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    payload: payload ?? null,
  }).then(({ error }) => {
    if (error) fastify.log.warn({ error }, 'Failed to write audit log')
  })
}

export default async function (fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (request, reply) => {
    await requireAdmin(fastify, request, reply)
  })

  const getQueue = () => {
    const queue = (fastify as any).uploadQueue
    if (!queue) throw new Error('Upload queue not available')
    return queue
  }

  // ── OVERVIEW ──────────────────────────────────────────────────────────────

  fastify.get('/overview', async (_request, reply) => {
    try {
      const [
        { count: totalUsers },
        { count: totalSpaces },
        { count: publishedSpaces },
        failedJobs,
        { data: subsByStatus },
        { data: planCounts },
        { data: storageData },
      ] = await Promise.all([
        fastify.supabase.from('profiles').select('id', { count: 'exact', head: true }),
        fastify.supabase.from('properties').select('id', { count: 'exact', head: true }),
        fastify.supabase.from('properties').select('id', { count: 'exact', head: true }).eq('is_published', true),
        getQueue().getFailed().catch(() => []),
        fastify.supabase.from('subscriptions').select('status').neq('status', 'canceled'),
        fastify.supabase.from('subscriptions')
          .select('plan_id, plans(name)', { count: 'exact' })
          .eq('status', 'active'),
        fastify.supabase.from('usage_counters').select('storage_used_bytes'),
      ])

      const activeCount = (subsByStatus ?? []).filter((s: any) =>
        ['active', 'trialing', 'trial'].includes(s.status)
      ).length

      const totalStorageBytes = (storageData ?? []).reduce(
        (sum: number, r: any) => sum + Number(r.storage_used_bytes || 0), 0
      )

      // Signups in last 7 days
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const { count: recentSignups } = await fastify.supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', sevenDaysAgo)

      return reply.send({
        success: true,
        data: {
          totalUsers: totalUsers ?? 0,
          totalSpaces: totalSpaces ?? 0,
          publishedSpaces: publishedSpaces ?? 0,
          activeSubscriptions: activeCount,
          failedJobs: (failedJobs as any[]).length,
          totalStorageBytes,
          recentSignups: recentSignups ?? 0,
        },
      })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch overview' })
    }
  })

  // ── USERS ──────────────────────────────────────────────────────────────────

  fastify.get('/users', async (request, reply) => {
    try {
      const { page = '1', limit = '25', search = '', plan = '', status = '' } = request.query as any
      const pageNum = Math.max(1, parseInt(page))
      const limitNum = Math.min(100, parseInt(limit))
      const from = (pageNum - 1) * limitNum
      const to = from + limitNum - 1

      let query = fastify.supabase
        .from('profiles')
        .select(`
          id, email, full_name, company_name, phone, is_admin,
          suspended_at, suspended_reason, created_at,
          subscriptions(plan_id, status, current_period_end, plans(id, name)),
          usage_counters(active_properties_count, storage_used_bytes)
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to)

      if (search) {
        query = query.or(`email.ilike.%${search}%,full_name.ilike.%${search}%,company_name.ilike.%${search}%`)
      }

      if (status === 'suspended') {
        query = query.not('suspended_at', 'is', null)
      }

      const { data, count, error } = await query
      if (error) throw error

      return reply.send({ success: true, data: { users: data, total: count, page: pageNum, limit: limitNum } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch users' })
    }
  })

  fastify.get('/users/:id', async (request, reply) => {
    try {
      const { id } = request.params as any

      const [
        { data: profile, error: profileError },
        { data: spaces, count: spacesCount },
        { count: leadsCount },
        { data: notes },
      ] = await Promise.all([
        fastify.supabase
          .from('profiles')
          .select(`
            id, email, full_name, company_name, phone, is_admin,
            suspended_at, suspended_reason, created_at, updated_at,
            subscriptions(*, plans(*)),
            usage_counters(*)
          `)
          .eq('id', id)
          .single(),
        fastify.supabase
          .from('properties')
          .select('id, title, slug, is_published, created_at, cover_image_url', { count: 'exact' })
          .eq('user_id', id)
          .order('created_at', { ascending: false })
          .limit(10),
        fastify.supabase
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .in(
            'property_id',
            (await fastify.supabase.from('properties').select('id').eq('user_id', id)).data?.map((p: any) => p.id) ?? [],
          ),
        fastify.supabase
          .from('admin_notes')
          .select('id, body, created_at, profiles!admin_notes_admin_id_fkey(full_name, email)')
          .eq('user_id', id)
          .order('created_at', { ascending: false }),
      ])

      if (profileError) {
        return reply.code(404).send({ statusMessage: 'User not found' })
      }

      return reply.send({
        success: true,
        data: { ...profile, spaces: spaces ?? [], spacesCount: spacesCount ?? 0, leadsCount: leadsCount ?? 0, notes: notes ?? [] },
      })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch user' })
    }
  })

  fastify.patch('/users/:id/profile', async (request, reply) => {
    try {
      const { id } = request.params as any
      const body = request.body as any
      const updates: Record<string, any> = { updated_at: new Date().toISOString() }
      if (body.full_name !== undefined) updates.full_name = body.full_name || null
      if (body.company_name !== undefined) updates.company_name = body.company_name || null
      if (body.phone !== undefined) updates.phone = body.phone || null
      if (body.email !== undefined) updates.email = body.email || null

      const { data, error } = await fastify.supabase
        .from('profiles').update(updates).eq('id', id).select().single()
      if (error) throw error

      await auditLog(fastify, request, 'update_profile', 'user', id, updates)
      return reply.send({ success: true, data })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to update profile' })
    }
  })

  fastify.patch('/users/:id/suspend', async (request, reply) => {
    try {
      const { id } = request.params as any
      const { suspend, reason } = request.body as any

      // Self-protection: cannot suspend your own account
      const adminId = request.headers['x-admin-id'] as string | undefined
      if (suspend && adminId && adminId === id) {
        return reply.code(403).send({ statusMessage: 'Cannot suspend your own admin account' })
      }

      const updates = suspend
        ? { suspended_at: new Date().toISOString(), suspended_reason: reason || null }
        : { suspended_at: null, suspended_reason: null }

      const { data, error } = await fastify.supabase
        .from('profiles').update(updates).eq('id', id).select().single()
      if (error) throw error

      await auditLog(fastify, request, suspend ? 'suspend_user' : 'unsuspend_user', 'user', id, { reason })
      fastify.log.warn({ id, suspend, reason }, 'Admin toggled user suspension')
      return reply.send({ success: true, data })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to update suspension' })
    }
  })

  fastify.delete('/users/:id', async (request, reply) => {
    try {
      const { id } = request.params as any

      // Self-protection: prevent admin from deleting their own account
      const adminId = request.headers['x-admin-id'] as string | undefined
      if (adminId && adminId === id) {
        return reply.code(403).send({ statusMessage: 'Cannot delete your own admin account' })
      }

      // Delete auth user FIRST — if this fails, nothing else is deleted
      const { error: authError } = await fastify.supabase.auth.admin.deleteUser(id)
      if (authError) {
        fastify.log.error({ id, authError }, 'Failed to delete Supabase auth user')
        return reply.code(500).send({ statusMessage: `Auth deletion failed: ${authError.message}` })
      }

      // Now delete DB records in dependency order
      await fastify.supabase.from('admin_notes').delete().eq('user_id', id)
      await fastify.supabase.from('subscriptions').delete().eq('user_id', id)
      await fastify.supabase.from('usage_counters').delete().eq('user_id', id)

      const { data: userSpaces } = await fastify.supabase
        .from('properties').select('id').eq('user_id', id)
      if (userSpaces?.length) {
        const spaceIds = userSpaces.map((s: any) => s.id)
        await fastify.supabase.from('leads').delete().in('property_id', spaceIds)
        await fastify.supabase.from('property_media').delete().in('property_id', spaceIds)
        await fastify.supabase.from('properties').delete().in('id', spaceIds)
      }

      await fastify.supabase.from('profiles').delete().eq('id', id)

      await auditLog(fastify, request, 'delete_user', 'user', id)
      fastify.log.warn({ id }, 'Admin deleted user account')
      return reply.send({ success: true, data: { deleted: true } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to delete user' })
    }
  })

  fastify.post('/users/:id/send-reset-email', async (request, reply) => {
    try {
      const { id } = request.params as any
      const { data: profile } = await fastify.supabase
        .from('profiles').select('email, full_name').eq('id', id).single()
      if (!profile?.email) return reply.code(404).send({ statusMessage: 'User email not found' })

      // generateLink returns the recovery URL — then we send it ourselves via Resend
      const { data: linkData, error: linkError } = await fastify.supabase.auth.admin.generateLink({
        type: 'recovery',
        email: profile.email,
      })
      if (linkError) throw linkError

      const recoveryUrl = (linkData as any)?.properties?.action_link
      if (!recoveryUrl) throw new Error('Failed to generate recovery link')

      const { Resend } = await import('resend')
      const resend = new Resend(process.env.RESEND_API_KEY)
      const name = profile.full_name?.trim().split(' ')[0] || null

      await resend.emails.send({
        from: 'Viewora <hello@viewora.software>',
        to: profile.email,
        subject: 'Reset your Viewora password',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a;">
            <div style="background: #0a0a0b; padding: 24px 32px; border-radius: 12px 12px 0 0; text-align: center;">
              <span style="color: #fff; font-size: 22px; font-weight: bold;">Viewora</span>
            </div>
            <div style="padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
              <h2 style="margin-top: 0;">Hi${name ? ` ${name}` : ''},</h2>
              <p style="color: #4b5563; line-height: 1.6;">
                An admin has requested a password reset for your account.
                Click the button below to set a new password.
              </p>
              <a href="${recoveryUrl}" style="display: inline-block; background: #0a0a0b; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 15px; margin: 24px 0;">
                Reset my password →
              </a>
              <p style="color: #6b7280; font-size: 13px;">
                This link expires in 24 hours. If you didn't request this, ignore this email.
              </p>
            </div>
          </div>
        `,
      })

      await auditLog(fastify, request, 'send_reset_email', 'user', id)
      return reply.send({ success: true, data: { sent: true, email: profile.email } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to send reset email' })
    }
  })

  fastify.post('/users/:id/transfer-spaces', async (request, reply) => {
    try {
      const { id } = request.params as any
      const { targetUserId } = request.body as any
      if (!targetUserId) return reply.code(400).send({ statusMessage: 'targetUserId required' })

      // Verify target user exists before transferring
      const { data: targetUser } = await fastify.supabase
        .from('profiles').select('id').eq('id', targetUserId).single()
      if (!targetUser) return reply.code(404).send({ statusMessage: 'Target user not found' })

      const { data, error } = await fastify.supabase
        .from('properties')
        .update({ user_id: targetUserId })
        .eq('user_id', id)
        .select('id')
      if (error) throw error

      await auditLog(fastify, request, 'transfer_spaces', 'user', id, { targetUserId, count: data?.length })
      return reply.send({ success: true, data: { transferred: data?.length ?? 0 } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to transfer spaces' })
    }
  })

  // ── NOTES ──────────────────────────────────────────────────────────────────

  fastify.get('/users/:id/notes', async (request, reply) => {
    const { id } = request.params as any
    const { data, error } = await fastify.supabase
      .from('admin_notes')
      .select('id, body, created_at, profiles!admin_notes_admin_id_fkey(full_name, email)')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
    if (error) return reply.code(500).send({ statusMessage: 'Failed to fetch notes' })
    return reply.send({ success: true, data })
  })

  fastify.post('/users/:id/notes', async (request, reply) => {
    const { id } = request.params as any
    const { body: noteBody } = request.body as any
    // adminId comes from the verified X-Admin-Id header, not request body
    const adminId = request.headers['x-admin-id'] as string | undefined
    if (!noteBody?.trim()) return reply.code(400).send({ statusMessage: 'Note body required' })
    if (!adminId) return reply.code(400).send({ statusMessage: 'Admin identity required' })

    const { data, error } = await fastify.supabase
      .from('admin_notes')
      .insert({ user_id: id, admin_id: adminId, body: noteBody.trim() })
      .select()
      .single()
    if (error) return reply.code(500).send({ statusMessage: 'Failed to add note' })
    return reply.send({ success: true, data })
  })

  fastify.delete('/users/:id/notes/:noteId', async (request, reply) => {
    const { noteId } = request.params as any
    const { error } = await fastify.supabase.from('admin_notes').delete().eq('id', noteId)
    if (error) return reply.code(500).send({ statusMessage: 'Failed to delete note' })
    return reply.send({ success: true, data: { deleted: true } })
  })

  // ── SUBSCRIPTIONS ──────────────────────────────────────────────────────────

  fastify.get('/subscriptions', async (request, reply) => {
    try {
      const { page = '1', limit = '25', status = '', plan = '' } = request.query as any
      const pageNum = Math.max(1, parseInt(page))
      const limitNum = Math.min(100, parseInt(limit))
      const from = (pageNum - 1) * limitNum
      const to = from + limitNum - 1

      let query = fastify.supabase
        .from('subscriptions')
        .select('*, plans(name, price_monthly_kes), profiles!subscriptions_user_id_fkey(id, email, full_name)', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to)

      if (status) query = query.eq('status', status)

      const { data, count, error } = await query
      if (error) throw error
      return reply.send({ success: true, data: { subscriptions: data, total: count, page: pageNum, limit: limitNum } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch subscriptions' })
    }
  })

  fastify.patch('/users/:id/subscription', async (request, reply) => {
    try {
      const { id } = request.params as any
      const body = request.body as any
      const updates: Record<string, any> = { updated_at: new Date().toISOString() }
      if (body.status !== undefined) updates.status = body.status
      if (body.plan_id !== undefined) updates.plan_id = body.plan_id
      if (body.current_period_end !== undefined) updates.current_period_end = body.current_period_end
      if (body.grace_period_ends_at !== undefined) updates.grace_period_ends_at = body.grace_period_ends_at

      const { data, error } = await fastify.supabase
        .from('subscriptions').update(updates).eq('user_id', id).select().single()
      if (error) throw error

      await auditLog(fastify, request, 'update_subscription', 'subscription', id, updates)
      return reply.send({ success: true, data })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to update subscription' })
    }
  })

  fastify.post('/users/:id/subscription/gift', async (request, reply) => {
    try {
      const { id } = request.params as any
      const { plan_id, billing_cycle = 'monthly', ends_at } = request.body as any
      if (!plan_id) return reply.code(400).send({ statusMessage: 'plan_id required' })

      const periodEnd = ends_at || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

      // Upsert — if subscription exists update it, otherwise create
      const { data: existing } = await fastify.supabase
        .from('subscriptions').select('id').eq('user_id', id).single()

      let data, error
      if (existing) {
        ({ data, error } = await fastify.supabase
          .from('subscriptions')
          .update({ plan_id, status: 'active', billing_cycle, current_period_end: periodEnd, provider: 'manual', updated_at: new Date().toISOString() })
          .eq('user_id', id).select().single())
      } else {
        ({ data, error } = await fastify.supabase
          .from('subscriptions')
          .insert({ user_id: id, plan_id, status: 'active', billing_cycle, current_period_start: new Date().toISOString(), current_period_end: periodEnd, provider: 'manual' })
          .select().single())
      }
      if (error) throw error

      await auditLog(fastify, request, 'gift_subscription', 'subscription', id, { plan_id, billing_cycle, ends_at: periodEnd })
      return reply.send({ success: true, data })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to gift subscription' })
    }
  })

  fastify.delete('/users/:id/subscription', async (request, reply) => {
    try {
      const { id } = request.params as any
      const { error } = await fastify.supabase
        .from('subscriptions')
        .update({ status: 'canceled', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('user_id', id)
      if (error) throw error

      await auditLog(fastify, request, 'cancel_subscription', 'subscription', id)
      return reply.send({ success: true, data: { canceled: true } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to cancel subscription' })
    }
  })

  // ── SPACES ──────────────────────────────────────────────────────────────────

  fastify.get('/spaces', async (request, reply) => {
    try {
      const { page = '1', limit = '25', search = '', published = '' } = request.query as any
      const pageNum = Math.max(1, parseInt(page))
      const limitNum = Math.min(100, parseInt(limit))
      const from = (pageNum - 1) * limitNum
      const to = from + limitNum - 1

      let query = fastify.supabase
        .from('properties')
        .select('id, title, slug, is_published, visibility, property_type, created_at, cover_image_url, profiles!properties_user_id_fkey(id, email, full_name)', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to)

      if (search) query = query.ilike('title', `%${search}%`)
      if (published === 'true') query = query.eq('is_published', true)
      if (published === 'false') query = query.eq('is_published', false)

      const { data, count, error } = await query
      if (error) throw error
      return reply.send({ success: true, data: { spaces: data, total: count, page: pageNum, limit: limitNum } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch spaces' })
    }
  })

  fastify.get('/spaces/:id', async (request, reply) => {
    try {
      const { id } = request.params as any
      const [
        { data: space, error },
        { data: media },
        { count: scenesCount },
        { count: leadsCount },
      ] = await Promise.all([
        fastify.supabase.from('properties')
          .select('*, profiles!properties_user_id_fkey(id, email, full_name)')
          .eq('id', id).single(),
        fastify.supabase.from('property_media').select('id, media_type, processing_status, file_size_bytes, created_at').eq('property_id', id).limit(20),
        fastify.supabase.from('property_media').select('id', { count: 'exact', head: true }).eq('property_id', id).eq('media_type', 'panorama'),
        fastify.supabase.from('leads').select('id', { count: 'exact', head: true }).eq('property_id', id),
      ])
      if (error) return reply.code(404).send({ statusMessage: 'Space not found' })
      return reply.send({ success: true, data: { ...space, media, scenesCount: scenesCount ?? 0, leadsCount: leadsCount ?? 0 } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch space' })
    }
  })

  fastify.patch('/spaces/:id', async (request, reply) => {
    try {
      const { id } = request.params as any
      const body = request.body as any
      const updates: Record<string, any> = { updated_at: new Date().toISOString() }
      if (body.is_published !== undefined) {
        updates.is_published = body.is_published
        updates.published_at = body.is_published ? new Date().toISOString() : null
      }
      if (body.visibility !== undefined) updates.visibility = body.visibility

      const { data, error } = await fastify.supabase
        .from('properties').update(updates).eq('id', id).select().single()
      if (error) throw error

      await auditLog(fastify, request, 'update_space', 'space', id, updates)
      return reply.send({ success: true, data })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to update space' })
    }
  })

  fastify.delete('/spaces/:id', async (request, reply) => {
    try {
      const { id } = request.params as any

      // Delete media records (R2 objects are cleaned up by existing cleanup scheduler)
      await fastify.supabase.from('property_media').delete().eq('property_id', id)
      await fastify.supabase.from('leads').delete().eq('property_id', id)
      await fastify.supabase.from('properties').delete().eq('id', id)

      await auditLog(fastify, request, 'delete_space', 'space', id)
      fastify.log.warn({ id }, 'Admin deleted space')
      return reply.send({ success: true, data: { deleted: true } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to delete space' })
    }
  })

  fastify.post('/spaces/:id/transfer', async (request, reply) => {
    try {
      const { id } = request.params as any
      const { targetUserId } = request.body as any
      if (!targetUserId) return reply.code(400).send({ statusMessage: 'targetUserId required' })

      // Verify target user exists
      const { data: targetUser } = await fastify.supabase
        .from('profiles').select('id').eq('id', targetUserId).single()
      if (!targetUser) return reply.code(404).send({ statusMessage: 'Target user not found' })

      const { data, error } = await fastify.supabase
        .from('properties').update({ user_id: targetUserId }).eq('id', id).select().single()
      if (error) throw error

      await auditLog(fastify, request, 'transfer_space', 'space', id, { targetUserId })
      return reply.send({ success: true, data })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to transfer space' })
    }
  })

  // ── MEDIA ──────────────────────────────────────────────────────────────────

  fastify.get('/media', async (request, reply) => {
    try {
      const { page = '1', limit = '25', status = '', user_id = '' } = request.query as any
      const pageNum = Math.max(1, parseInt(page))
      const limitNum = Math.min(100, parseInt(limit))
      const from = (pageNum - 1) * limitNum
      const to = from + limitNum - 1

      let query = fastify.supabase
        .from('property_media')
        .select(`
          id, media_type, processing_status, file_size_bytes, storage_key, created_at,
          properties!property_media_property_id_fkey(id, title, user_id, profiles!properties_user_id_fkey(email, full_name))
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to)

      if (status) query = query.eq('processing_status', status)

      const { data, count, error } = await query
      if (error) throw error
      return reply.send({ success: true, data: { media: data, total: count, page: pageNum, limit: limitNum } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch media' })
    }
  })

  fastify.post('/media/:id/reprocess', async (request, reply) => {
    try {
      const { id } = request.params as any
      const { data: media, error } = await fastify.supabase
        .from('property_media')
        .select('id, storage_key, property_id, properties!property_media_property_id_fkey(user_id)')
        .eq('id', id)
        .single()
      if (error || !media) return reply.code(404).send({ statusMessage: 'Media not found' })

      const queue = getQueue()
      await queue.add('process-media', {
        mediaId: media.id,
        objectKey: media.storage_key,
        spaceId: media.property_id,
        userId: (media as any).properties?.user_id,
      })

      await fastify.supabase
        .from('property_media')
        .update({ processing_status: 'pending' })
        .eq('id', id)

      await auditLog(fastify, request, 'reprocess_media', 'media', id)
      return reply.send({ success: true, data: { queued: true } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to reprocess media' })
    }
  })

  // ── Re-tile scenes onto the coarser full-res grid ─────────────────────────
  // Scenes tiled before the grid change have 32×16 full-res tiles of ~372px.
  // Re-queues them so tile-processor cuts the new grid (16×8 of ~744px for 12K).
  // Each job writes into a fresh `v/retile-…` folder: tiles are immutable-cached
  // and the old/new grids share file names, so overwriting in place would mix
  // stale tiles into the new grid. The scene keeps serving its old tiles until
  // the job flips tile_manifest_url at the end.
  //   ?dryRun=true  → only count/list what would be queued
  //   ?limit=N      → batch size (default 100, max 1000); safe to run again —
  //                   re-tiled scenes no longer match, queued ones are deduped
  fastify.post('/scenes/retile', async (request, reply) => {
    try {
      const { dryRun, limit } = request.query as { dryRun?: string; limit?: string }
      const limitNum = Math.min(Math.max(parseInt(limit || '100', 10) || 100, 1), 1000)

      const { data: scenes, count, error } = await fastify.supabase
        .from('scenes')
        .select('id, space_id, raw_image_url, tile_cols', { count: 'exact' })
        .gt('tile_cols', 16)
        .eq('tiles_ready', true)
        .not('raw_image_url', 'is', null)
        .order('created_at', { ascending: true })
        .limit(limitNum)
      if (error) throw error

      if (dryRun === 'true') {
        return reply.send({ success: true, data: { matching: count ?? 0, batch: scenes?.map(s => s.id) ?? [] } })
      }

      const queue = getQueue()
      let queued = 0
      for (const scene of scenes ?? []) {
        // Fixed jobId: running this again while a job is still waiting is a no-op
        // (completed jobs are removed, so a failed re-tile can be retried later).
        // Lowest priority so customers' new uploads are never stuck behind a backfill.
        await queue.add('tile-scene', {
          sceneId: scene.id,
          rawImageUrl: scene.raw_image_url,
          spaceId: scene.space_id,
          variant: `retile-${randomUUID()}`,
        }, {
          jobId: `retile-${scene.id}`,
          priority: 100,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        })
        queued++
      }

      await auditLog(fastify, request, 'retile_scenes', 'scene', 'batch', { queued, matching: count ?? 0 })
      return reply.send({ success: true, data: { queued, matching: count ?? 0, remaining: Math.max((count ?? 0) - queued, 0) } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to queue re-tile' })
    }
  })

  fastify.delete('/media/:id', async (request, reply) => {
    try {
      const { id } = request.params as any
      const { data: media } = await fastify.supabase
        .from('property_media').select('storage_key, file_size_bytes, properties!property_media_property_id_fkey(user_id)').eq('id', id).single()

      if (media?.storage_key) {
        try {
          const s3 = (fastify as any).s3
          if (s3) await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: media.storage_key }))
        } catch { /* continue even if R2 fails */ }
      }

      await fastify.supabase.from('property_media').delete().eq('id', id)
      await auditLog(fastify, request, 'delete_media', 'media', id)
      return reply.send({ success: true, data: { deleted: true } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to delete media' })
    }
  })

  fastify.post('/media/purge-orphans', async (request, reply) => {
    try {
      const { dryRun = true } = request.body as any

      // List all R2 objects
      const s3 = (fastify as any).s3
      if (!s3) return reply.code(503).send({ statusMessage: 'S3 not available' })

      const listedObjects: string[] = []
      let continuationToken: string | undefined
      do {
        const res = await s3.send(new ListObjectsV2Command({
          Bucket: process.env.R2_BUCKET_NAME,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }))
        listedObjects.push(...(res.Contents ?? []).map((o: any) => o.Key))
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (continuationToken)

      // Get all known storage keys from DB
      const { data: dbKeys, count: dbCount } = await fastify.supabase
        .from('property_media').select('storage_key', { count: 'exact' })

      // Safety: refuse purge if DB returned 0 records and R2 has objects
      // (would incorrectly classify everything as orphaned)
      if (!dryRun && (dbCount === 0 || dbCount === null) && listedObjects.length > 0) {
        return reply.code(409).send({
          statusMessage: 'Safety check failed: DB returned 0 media records but R2 has objects. Run dry-run first.',
        })
      }

      const knownSet = new Set((dbKeys ?? []).map((r: any) => r.storage_key))
      const orphans = listedObjects.filter(k => !knownSet.has(k))

      if (!dryRun && orphans.length > 0) {
        for (const key of orphans) {
          await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }))
        }
        fastify.log.warn({ count: orphans.length }, 'Admin purged orphaned R2 objects')
        await auditLog(fastify, request, 'purge_orphans', 'media', 'bulk', { count: orphans.length })
      }

      return reply.send({ success: true, data: { orphanCount: orphans.length, purged: !dryRun, dryRun } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to purge orphans' })
    }
  })

  // ── QUEUE ──────────────────────────────────────────────────────────────────

  fastify.get('/cleanup-health', async (_request, reply) => {
    try {
      return reply.send({ success: true, data: getCleanupDashboardState() })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch cleanup health' })
    }
  })

  fastify.get('/failed-jobs', async (_request, reply) => {
    try {
      const queue = getQueue()
      const failedJobs = await queue.getFailed()
      const jobs = failedJobs.map((job: any) => ({
        jobId: job.id,
        mediaId: job.data.mediaId,
        spaceId: job.data.spaceId,
        userId: job.data.userId,
        objectKey: job.data.objectKey,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason,
        stackTrace: job.stacktrace?.[0] || null,
        createdTimestamp: job.timestamp,
      }))
      return reply.send({ success: true, data: { count: jobs.length, jobs } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch failed jobs' })
    }
  })

  fastify.get('/queue-stats', async (_request, reply) => {
    try {
      const queue = getQueue()
      const [waitingCount, failedCount, activeCount, completedCount, isPaused] = await Promise.all([
        queue.count(),
        queue.getFailed(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.isPaused(),
      ])
      return reply.send({
        success: true,
        data: { waiting: waitingCount, active: activeCount, completed: completedCount, failed: failedCount.length, isPaused },
      })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch queue stats' })
    }
  })

  fastify.post('/queue/pause', async (request, reply) => {
    try {
      await getQueue().pause()
      await auditLog(fastify, request, 'pause_queue', 'queue', 'upload')
      return reply.send({ success: true, data: { paused: true } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to pause queue' })
    }
  })

  fastify.post('/queue/resume', async (request, reply) => {
    try {
      await getQueue().resume()
      await auditLog(fastify, request, 'resume_queue', 'queue', 'upload')
      return reply.send({ success: true, data: { resumed: true } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to resume queue' })
    }
  })

  fastify.post<{ Params: { jobId: string } }>('/retry-job/:jobId', async (request, reply) => {
    try {
      const { jobId } = request.params
      const queue = getQueue()
      const job = await queue.getJob(jobId)
      if (!job) return reply.code(404).send({ statusMessage: 'Job not found' })
      const state = await job.getState()
      if (state !== 'failed') return reply.code(409).send({ statusMessage: `Can only retry failed jobs. Current state: ${state}` })
      await job.retry()
      await auditLog(fastify, request, 'retry_job', 'queue', jobId)
      return reply.send({ success: true, data: { jobId, mediaId: job.data.mediaId, status: 'requeued' } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to retry job' })
    }
  })

  fastify.post('/retry-all-failed', async (request, reply) => {
    try {
      const queue = getQueue()
      const failedJobs = await queue.getFailed()
      let retried = 0
      for (const job of failedJobs) {
        try { await job.retry(); retried++ } catch { /* skip individual failures */ }
      }
      await auditLog(fastify, request, 'retry_all_failed', 'queue', 'bulk', { retried, total: failedJobs.length })
      return reply.send({ success: true, data: { retried, total: failedJobs.length } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to retry all jobs' })
    }
  })

  fastify.delete<{ Params: { jobId: string } }>('/failed-job/:jobId', async (request, reply) => {
    try {
      const { jobId } = request.params
      const queue = getQueue()
      const job = await queue.getJob(jobId)
      if (!job) return reply.code(404).send({ statusMessage: 'Job not found' })
      await job.remove()
      await auditLog(fastify, request, 'delete_job', 'queue', jobId)
      return reply.send({ success: true, data: { jobId, deleted: true } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to delete job' })
    }
  })

  fastify.delete('/failed-jobs/all', async (request, reply) => {
    try {
      const queue = getQueue()
      const failedJobs = await queue.getFailed()
      let removed = 0
      for (const job of failedJobs) {
        try { await job.remove(); removed++ } catch { /* skip */ }
      }
      await auditLog(fastify, request, 'purge_all_failed_jobs', 'queue', 'bulk', { removed })
      return reply.send({ success: true, data: { removed } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to purge failed jobs' })
    }
  })

  fastify.post('/failed-media/cleanup', async (request, reply) => {
    try {
      const queue = getQueue()
      const failedJobs = await queue.getFailed()
      let cleanedCount = 0
      for (const job of failedJobs) {
        const { mediaId } = job.data
        const result = await fastify.supabase
          .from('property_media')
          .update({ marked_for_cleanup: true, marked_for_cleanup_at: new Date().toISOString() })
          .eq('id', mediaId)
          .eq('processing_status', 'failed')
        if (!result.error) cleanedCount++
      }
      return reply.send({ success: true, data: { markedForCleanup: cleanedCount, totalFailed: failedJobs.length } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to cleanup failed media' })
    }
  })

  // ── LEADS ──────────────────────────────────────────────────────────────────

  fastify.get('/leads', async (request, reply) => {
    try {
      const { page = '1', limit = '25', search = '', status = '' } = request.query as any
      const pageNum = Math.max(1, parseInt(page))
      const limitNum = Math.min(100, parseInt(limit))
      const from = (pageNum - 1) * limitNum
      const to = from + limitNum - 1

      let query = fastify.supabase
        .from('leads')
        .select('*, properties!leads_property_id_fkey(id, title, slug, profiles!properties_user_id_fkey(email, full_name))', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to)

      if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`)
      if (status) query = query.eq('status', status)

      const { data, count, error } = await query
      if (error) throw error
      return reply.send({ success: true, data: { leads: data, total: count, page: pageNum, limit: limitNum } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch leads' })
    }
  })

  fastify.delete('/leads/:id', async (request, reply) => {
    try {
      const { id } = request.params as any
      await fastify.supabase.from('leads').delete().eq('id', id)
      await auditLog(fastify, request, 'delete_lead', 'lead', id)
      return reply.send({ success: true, data: { deleted: true } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to delete lead' })
    }
  })

  fastify.post('/leads/bulk-delete', async (request, reply) => {
    try {
      const { ids } = request.body as any
      if (!Array.isArray(ids) || !ids.length) return reply.code(400).send({ statusMessage: 'ids array required' })
      await fastify.supabase.from('leads').delete().in('id', ids)
      await auditLog(fastify, request, 'bulk_delete_leads', 'lead', 'bulk', { count: ids.length })
      return reply.send({ success: true, data: { deleted: ids.length } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to bulk delete leads' })
    }
  })

  // ── PROPERTY REPORTS ───────────────────────────────────────────────────────
  // §13.3 Report Button — buyer-submitted flags (POST /reports, public,
  // routes/reports.ts). Deliberately not auto-actioned: an admin reviews
  // here and unpublishes via the existing PATCH /admin/spaces/:id if the
  // report is legitimate, rather than a single report silently hiding a
  // listing (a report-bombing vector against a competitor otherwise).
  fastify.get('/reports', async (request, reply) => {
    try {
      const { page = '1', limit = '25', status = '' } = request.query as any
      const pageNum = Math.max(1, parseInt(page))
      const limitNum = Math.min(100, parseInt(limit))
      const from = (pageNum - 1) * limitNum
      const to = from + limitNum - 1

      let query = fastify.supabase
        .from('property_reports')
        .select('*, properties(id, title, slug, is_published, profiles!properties_user_id_fkey(email, full_name))', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to)

      if (status) query = query.eq('status', status)

      const { data, count, error } = await query
      if (error) throw error
      return reply.send({ success: true, data: { reports: data, total: count, page: pageNum, limit: limitNum } })
    } catch {
      return reply.code(500).send({ statusMessage: 'Failed to fetch reports' })
    }
  })

  fastify.patch('/reports/:id', async (request, reply) => {
    try {
      const { id } = request.params as any
      const { status } = request.body as any
      const allowed = ['pending', 'reviewed', 'dismissed']
      if (!allowed.includes(status)) return reply.code(400).send({ statusMessage: 'Invalid status' })
      const { data, error } = await fastify.supabase
        .from('property_reports').update({ status }).eq('id', id).select('id, status').single()
      if (error) throw error
      await auditLog(fastify, request, 'update_report_status', 'property_report', id, { status })
      return reply.send({ success: true, data })
    } catch {
      return reply.code(500).send({ statusMessage: 'Failed to update report' })
    }
  })

  fastify.delete('/reports/:id', async (request, reply) => {
    try {
      const { id } = request.params as any
      await fastify.supabase.from('property_reports').delete().eq('id', id)
      await auditLog(fastify, request, 'delete_report', 'property_report', id)
      return reply.send({ success: true, data: { deleted: true } })
    } catch {
      return reply.code(500).send({ statusMessage: 'Failed to delete report' })
    }
  })

  // ── CAPTURE REQUESTS ───────────────────────────────────────────────────────

  fastify.get('/capture-requests', async (request, reply) => {
    try {
      const { page = '1', limit = '50', search = '', status = '', dept = '' } = request.query as any
      const pageNum  = Math.max(1, parseInt(page))
      const limitNum = Math.min(200, parseInt(limit))
      const from = (pageNum - 1) * limitNum
      const to   = from + limitNum - 1

      // name/email/phone are stored directly on the row — no join needed
      let q = fastify.supabase
        .from('capture_requests')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to)

      if (search) q = q.or(`name.ilike.%${search}%,email.ilike.%${search}%,address.ilike.%${search}%`)
      if (status) q = q.eq('status', status)
      if (dept)   q = q.eq('dept', dept)

      const { data, count, error } = await q
      if (error) {
        fastify.log.error(error, 'capture_requests query failed — table may not exist yet')
        // Return empty rather than 500 if the table hasn't been created yet
        return reply.send({ success: true, data: { requests: [], total: 0, page: pageNum, limit: limitNum, hint: 'Run migration-capture-requests.sql in Supabase to create the table.' } })
      }
      return reply.send({ success: true, data: { requests: data ?? [], total: count ?? 0, page: pageNum, limit: limitNum } })
    } catch (err: any) {
      fastify.log.error(err, 'Failed to fetch capture requests')
      return reply.code(500).send({ statusMessage: 'Failed to fetch capture requests' })
    }
  })

  fastify.patch('/capture-requests/:id', async (request, reply) => {
    try {
      const { id } = request.params as any
      const { status } = request.body as any
      const allowed = ['pending', 'confirmed', 'completed', 'cancelled']
      if (!allowed.includes(status)) return reply.code(400).send({ statusMessage: 'Invalid status' })
      const { data, error } = await fastify.supabase
        .from('capture_requests').update({ status }).eq('id', id).select('id, status').single()
      if (error) throw error
      await auditLog(fastify, request, 'update_capture_status', 'capture_request', id, { status })
      return reply.send({ success: true, data })
    } catch {
      return reply.code(500).send({ statusMessage: 'Failed to update status' })
    }
  })

  fastify.delete('/capture-requests/:id', async (request, reply) => {
    try {
      const { id } = request.params as any
      await fastify.supabase.from('capture_requests').delete().eq('id', id)
      await auditLog(fastify, request, 'delete_capture_request', 'capture_request', id)
      return reply.send({ success: true })
    } catch {
      return reply.code(500).send({ statusMessage: 'Failed to delete capture request' })
    }
  })

  // ── PLANS ──────────────────────────────────────────────────────────────────

  fastify.get('/plans', async (_request, reply) => {
    try {
      const { data: plans } = await fastify.supabase
        .from('plans').select('*')
        .order('sort_order', { ascending: true })
        .order('price_monthly_kes', { ascending: true })

      // Add subscriber count per plan
      const plansWithCounts = await Promise.all((plans ?? []).map(async (plan: any) => {
        const { count } = await fastify.supabase
          .from('subscriptions')
          .select('id', { count: 'exact', head: true })
          .eq('plan_id', plan.id)
          .in('status', ['active', 'trialing', 'trial'])
        return { ...plan, activeSubscriberCount: count ?? 0 }
      }))

      return reply.send({ success: true, data: plansWithCounts })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch plans' })
    }
  })

  // Display/marketing configuration — safe for an admin to tweak without billing risk
  const PLAN_DISPLAY_FIELDS = [
    'name', 'slug', 'description', 'cta_label', 'is_active', 'is_popular', 'is_legacy', 'sort_order',
  ] as const

  // Billing/entitlement configuration — changing these affects what customers are charged
  // or what they're entitled to. Kept in a separate list so the admin UI can visually
  // separate "safe to edit" from "affects billing" and warn accordingly.
  const PLAN_BILLING_FIELDS = [
    'price_monthly_kes', 'price_yearly_kes', 'is_custom_pricing', 'paystack_plan_code',
    'max_active_properties', 'max_scenes_per_tour', 'max_storage_bytes', 'max_upload_bytes',
    'max_team_members', 'shoot_allowance',
    'qr_download_enabled', 'qr_svg_enabled', 'embeds_enabled', 'advanced_embeds_enabled',
    'lead_capture_enabled', 'advanced_analytics_enabled', 'branding_customization_enabled',
    'features',
  ] as const

  const PLAN_FIELDS = [...PLAN_DISPLAY_FIELDS, ...PLAN_BILLING_FIELDS] as const

  function pickPlanFields(body: any) {
    const out: Record<string, any> = {}
    for (const key of PLAN_FIELDS) {
      if (body[key] !== undefined) out[key] = body[key]
    }
    return out
  }

  const NON_NEGATIVE_NUMERIC_FIELDS = [
    'price_monthly_kes', 'price_yearly_kes', 'max_active_properties', 'max_scenes_per_tour',
    'max_storage_bytes', 'max_upload_bytes', 'max_team_members', 'sort_order', 'shoot_allowance',
  ] as const
  const BOOLEAN_FIELDS = [
    'is_active', 'is_popular', 'is_legacy', 'is_custom_pricing',
    'qr_download_enabled', 'qr_svg_enabled', 'embeds_enabled', 'advanced_embeds_enabled',
    'lead_capture_enabled', 'advanced_analytics_enabled', 'branding_customization_enabled',
  ] as const
  const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

  function validatePlanBody(body: Record<string, any>, isCreate: boolean): string[] {
    const errors: string[] = []

    if (isCreate && !String(body.name ?? '').trim()) errors.push('name is required')
    if (body.name !== undefined && !String(body.name).trim()) errors.push('name cannot be empty')

    if (isCreate && body.slug === undefined) errors.push('slug is required')
    if (body.slug !== undefined && !SLUG_PATTERN.test(String(body.slug))) {
      errors.push('slug must be lowercase-kebab-case (e.g. "creator")')
    }

    for (const key of NON_NEGATIVE_NUMERIC_FIELDS) {
      const v = body[key]
      if (v === undefined || v === null) continue // null = unlimited/custom, allowed
      if (typeof v !== 'number' || Number.isNaN(v) || v < 0) errors.push(`${key} must be a non-negative number or null`)
    }

    for (const key of BOOLEAN_FIELDS) {
      const v = body[key]
      if (v === undefined || v === null) continue
      if (typeof v !== 'boolean') errors.push(`${key} must be a boolean`)
    }

    if (body.is_custom_pricing !== true && body.price_monthly_kes === null) {
      errors.push('price_monthly_kes cannot be null unless is_custom_pricing is true')
    }

    if (body.features !== undefined && body.features !== null && typeof body.features !== 'object') {
      errors.push('features must be an object or array')
    }

    return errors
  }

  async function assertSlugUnique(fastify: FastifyInstance, slug: string, excludeId?: string) {
    let q = fastify.supabase.from('plans').select('id').eq('slug', slug)
    if (excludeId) q = q.neq('id', excludeId)
    const { data } = await q.maybeSingle()
    return !data
  }

  fastify.post('/plans', async (request, reply) => {
    try {
      const body = pickPlanFields(request.body as any)
      const errors = validatePlanBody(body, true)
      if (errors.length) return reply.code(400).send({ statusMessage: errors.join('; '), errors })
      if (!(await assertSlugUnique(fastify, body.slug))) {
        return reply.code(409).send({ statusMessage: `A plan with slug "${body.slug}" already exists` })
      }

      const { data, error } = await fastify.supabase.from('plans').insert(body).select().single()
      if (error) throw error
      await auditLog(fastify, request, 'create_plan', 'plan', data.id, body)
      return reply.code(201).send({ success: true, data })
    } catch (error: any) {
      fastify.log.error(error, 'Failed to create plan')
      return reply.code(500).send({ statusMessage: error?.message || 'Failed to create plan' })
    }
  })

  fastify.patch('/plans/:id', async (request, reply) => {
    try {
      const { id } = request.params as any
      const body = pickPlanFields(request.body as any)
      const errors = validatePlanBody(body, false)
      if (errors.length) return reply.code(400).send({ statusMessage: errors.join('; '), errors })
      if (body.slug !== undefined && !(await assertSlugUnique(fastify, body.slug, id))) {
        return reply.code(409).send({ statusMessage: `A plan with slug "${body.slug}" already exists` })
      }

      // Warn (non-blocking) when billing-relevant fields change on a plan with active
      // subscribers — the change applies to them too since we don't do proration/versioning.
      let billingChangeWarning: string | undefined
      if (PLAN_BILLING_FIELDS.some((k) => body[k] !== undefined)) {
        const { count } = await fastify.supabase
          .from('subscriptions').select('id', { count: 'exact', head: true })
          .eq('plan_id', id).in('status', ['active', 'trialing', 'trial'])
        if ((count ?? 0) > 0) {
          billingChangeWarning = `This plan has ${count} active subscriber(s) — billing/limit changes apply to them immediately, there is no proration.`
        }
      }

      const { data, error } = await fastify.supabase
        .from('plans').update({ ...body, updated_at: new Date().toISOString() }).eq('id', id).select().single()
      if (error) throw error
      await auditLog(fastify, request, 'update_plan', 'plan', id, body)
      return reply.send({ success: true, data, warning: billingChangeWarning })
    } catch (error: any) {
      fastify.log.error(error, 'Failed to update plan')
      return reply.code(500).send({ statusMessage: error?.message || 'Failed to update plan' })
    }
  })

  fastify.delete('/plans/:id', async (request, reply) => {
    try {
      const { id } = request.params as any
      const { count } = await fastify.supabase
        .from('subscriptions').select('id', { count: 'exact', head: true }).eq('plan_id', id).in('status', ['active', 'trialing', 'trial'])
      if ((count ?? 0) > 0) return reply.code(409).send({ statusMessage: `Cannot delete — ${count} active subscribers on this plan` })
      await fastify.supabase.from('plans').delete().eq('id', id)
      await auditLog(fastify, request, 'delete_plan', 'plan', id)
      return reply.send({ success: true, data: { deleted: true } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to delete plan' })
    }
  })

  // ── EMAIL ──────────────────────────────────────────────────────────────────

  fastify.post('/email/send', async (request, reply) => {
    try {
      const { userId, subject, html } = request.body as any
      if (!userId || !subject || !html) return reply.code(400).send({ statusMessage: 'userId, subject, html required' })

      const { data: profile } = await fastify.supabase
        .from('profiles').select('email, full_name').eq('id', userId).single()
      if (!profile?.email) return reply.code(404).send({ statusMessage: 'User email not found' })

      const { Resend } = await import('resend')
      const resend = new Resend(process.env.RESEND_API_KEY)
      await resend.emails.send({
        from: 'Viewora <hello@viewora.software>',
        to: profile.email,
        subject,
        html,
      })

      await auditLog(fastify, request, 'send_email', 'user', userId, { subject })
      return reply.send({ success: true, data: { sent: true, to: profile.email } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to send email' })
    }
  })

  fastify.post('/email/broadcast', async (request, reply) => {
    try {
      const { subject, html, filter = {} } = request.body as any
      if (!subject || !html) return reply.code(400).send({ statusMessage: 'subject and html required' })
      if (subject.length > 200) return reply.code(400).send({ statusMessage: 'Subject too long (max 200 chars)' })
      if (html.length > 100_000) return reply.code(400).send({ statusMessage: 'HTML too large (max 100KB)' })

      let query = fastify.supabase.from('profiles').select('id, email, full_name')
      if (filter.plan) {
        const { data: subs } = await fastify.supabase
          .from('subscriptions').select('user_id').eq('plan_id', filter.plan)
        const ids = (subs ?? []).map((s: any) => s.user_id)
        if (!ids.length) return reply.send({ success: true, data: { sent: 0 } })
        query = query.in('id', ids)
      }
      if (filter.status === 'active') {
        const { data: subs } = await fastify.supabase
          .from('subscriptions').select('user_id').in('status', ['active', 'trialing', 'trial'])
        const ids = (subs ?? []).map((s: any) => s.user_id)
        if (!ids.length) return reply.send({ success: true, data: { sent: 0 } })
        query = query.in('id', ids)
      }
      if (filter.status === 'free') {
        const { data: subs } = await fastify.supabase.from('subscriptions').select('user_id')
        const paidIds = new Set((subs ?? []).map((s: any) => s.user_id))
        const { data: allProfiles } = await fastify.supabase.from('profiles').select('id, email, full_name')
        const freeProfiles = (allProfiles ?? []).filter((p: any) => !paidIds.has(p.id) && p.email)
        const { Resend } = await import('resend')
        const resend = new Resend(process.env.RESEND_API_KEY)
        let sent = 0
        for (const p of freeProfiles) {
          try { await resend.emails.send({ from: 'Viewora <hello@viewora.software>', to: p.email, subject, html }); sent++ } catch { /* skip */ }
        }
        await auditLog(fastify, request, 'broadcast_email', 'broadcast', 'bulk', { subject, sent, filter })
        return reply.send({ success: true, data: { sent } })
      }

      const { data: recipients } = await query
      if (!recipients?.length) return reply.send({ success: true, data: { sent: 0 } })

      const { Resend } = await import('resend')
      const resend = new Resend(process.env.RESEND_API_KEY)
      let sent = 0
      for (const p of recipients) {
        if (!p.email) continue
        try { await resend.emails.send({ from: 'Viewora <hello@viewora.software>', to: p.email, subject, html }); sent++ } catch { /* skip */ }
      }

      await auditLog(fastify, request, 'broadcast_email', 'broadcast', 'bulk', { subject, sent, filter })
      return reply.send({ success: true, data: { sent } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to broadcast email' })
    }
  })

  // ── ANALYTICS ─────────────────────────────────────────────────────────────

  fastify.get('/analytics/platform', async (_request, reply) => {
    try {
      const days = 30
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

      const [
        { data: signups },
        { data: publishedByDay },
        { data: totalViews },
      ] = await Promise.all([
        fastify.supabase.from('profiles').select('created_at').gte('created_at', since).order('created_at', { ascending: true }),
        fastify.supabase.from('properties').select('published_at').not('published_at', 'is', null).gte('published_at', since),
        fastify.supabase.from('analytics_daily').select('date, total_views, leads_count').gte('date', since.split('T')[0]),
      ])

      return reply.send({
        success: true,
        data: {
          signups: signups ?? [],
          publishedByDay: publishedByDay ?? [],
          viewsByDay: totalViews ?? [],
          period: `last_${days}_days`,
        },
      })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch platform analytics' })
    }
  })

  fastify.get('/analytics/storage', async (_request, reply) => {
    try {
      const { data } = await fastify.supabase
        .from('usage_counters')
        .select('user_id, storage_used_bytes, profiles!usage_counters_user_id_fkey(email, full_name)')
        .order('storage_used_bytes', { ascending: false })
        .limit(50)

      const total = (data ?? []).reduce((s: number, r: any) => s + Number(r.storage_used_bytes || 0), 0)
      return reply.send({ success: true, data: { topUsers: data ?? [], totalBytes: total } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch storage analytics' })
    }
  })

  // ── SYSTEM HEALTH ─────────────────────────────────────────────────────────

  fastify.get('/system-health', async (_request, reply) => {
    try {
      const queue = getQueue()
      const [
        queueStats,
        failedJobsArr,
        redisOk,
        supabaseOk,
      ] = await Promise.all([
        Promise.all([queue.count(), queue.getActiveCount(), queue.getCompletedCount(), queue.isPaused()]).then(([w, a, c, p]) => ({ waiting: w, active: a, completed: c, paused: p })),
        queue.getFailed().then((j: any[]) => j.length).catch(() => -1),
        (fastify as any).redis ? (fastify as any).redis.ping().then(() => true).catch(() => false) : Promise.resolve(null),
        fastify.supabase.from('profiles').select('id', { count: 'exact', head: true }).then(({ error }) => !error),
      ])

      return reply.send({
        success: true,
        data: {
          queue: { ...queueStats, failed: failedJobsArr },
          redis: redisOk,
          supabase: supabaseOk,
          uptime: process.uptime(),
          memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
          nodeVersion: process.version,
        },
      })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch system health' })
    }
  })

  // ── AUDIT LOG ─────────────────────────────────────────────────────────────

  fastify.get('/audit-log', async (request, reply) => {
    try {
      const { page = '1', limit = '50', action = '', resource_type = '' } = request.query as any
      const pageNum = Math.max(1, parseInt(page))
      const limitNum = Math.min(200, parseInt(limit))
      const from = (pageNum - 1) * limitNum
      const to = from + limitNum - 1

      let query = fastify.supabase
        .from('admin_audit_log')
        .select('*, profiles!admin_audit_log_admin_id_fkey(email, full_name)', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to)

      if (action) query = query.eq('action', action)
      if (resource_type) query = query.eq('resource_type', resource_type)

      const { data, count, error } = await query
      if (error) throw error
      return reply.send({ success: true, data: { logs: data, total: count, page: pageNum, limit: limitNum } })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch audit log' })
    }
  })

  // ── MISSING SCENARIOS ──────────────────────────────────────────────────────

  /**
   * POST /admin/users/:id/recalculate-usage
   * Recalculates storage_used_bytes and active_properties_count from actual DB data.
   * Use when a user's quota counter gets out of sync.
   */
  fastify.post('/users/:id/recalculate-usage', async (request, reply) => {
    try {
      const { id } = request.params as any

      // Get all space IDs for this user first, then sum media sizes
      const { data: userSpaces } = await fastify.supabase
        .from('properties').select('id').eq('user_id', id)
      const spaceIds = userSpaces?.map((s: any) => s.id) ?? []

      const [
        { data: mediaRows },
        { count: activeSpaces },
      ] = await Promise.all([
        spaceIds.length
          ? fastify.supabase.from('property_media').select('file_size_bytes').in('property_id', spaceIds)
          : Promise.resolve({ data: [] }),
        fastify.supabase
          .from('properties')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', id)
          .eq('is_published', true),
      ])

      const storageBytesActual = (mediaRows ?? []).reduce((sum: number, r: any) => sum + Number(r.file_size_bytes || 0), 0)
      const activeCount = activeSpaces ?? 0

      const { error } = await fastify.supabase
        .from('usage_counters')
        .upsert({
          user_id: id,
          storage_used_bytes: storageBytesActual,
          active_properties_count: activeCount,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' })

      if (error) throw error

      await auditLog(fastify, request, 'recalculate_usage', 'user', id, {
        storage_used_bytes: storageBytesActual,
        active_properties_count: activeCount,
      })

      return reply.send({
        success: true,
        data: { storage_used_bytes: storageBytesActual, active_properties_count: activeCount },
      })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to recalculate usage' })
    }
  })

  /**
   * POST /admin/users/:id/revoke-sessions
   * Signs out the user from all devices by invalidating their Supabase sessions.
   * Use for compromised accounts or immediate access revocation.
   */
  fastify.post('/users/:id/revoke-sessions', async (request, reply) => {
    try {
      const { id } = request.params as any

      const { error } = await fastify.supabase.auth.admin.signOut(id, 'global')
      if (error) throw error

      await auditLog(fastify, request, 'revoke_sessions', 'user', id)
      fastify.log.warn({ id }, 'Admin revoked all sessions for user')
      return reply.send({ success: true, data: { revoked: true } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to revoke sessions' })
    }
  })

  /**
   * POST /admin/users/:id/verify-email
   * Force-marks the user's email as confirmed in Supabase Auth.
   * Use when a user can't receive verification email but you've confirmed their identity.
   */
  fastify.post('/users/:id/verify-email', async (request, reply) => {
    try {
      const { id } = request.params as any

      const { data, error } = await fastify.supabase.auth.admin.updateUserById(id, {
        email_confirm: true,
      })
      if (error) throw error

      await auditLog(fastify, request, 'verify_email', 'user', id)
      return reply.send({ success: true, data: { verified: true, email: data.user?.email } })
    } catch (error: any) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to verify email' })
    }
  })

  /**
   * GET /admin/leads/export
   * Returns all leads as CSV. Capped at 10,000 rows.
   */
  fastify.get('/leads/export', async (request, reply) => {
    try {
      const { search = '', status = '' } = request.query as any

      let query = fastify.supabase
        .from('leads')
        .select('id, name, email, phone, message, source, status, created_at, properties!leads_property_id_fkey(title, slug, profiles!properties_user_id_fkey(email))')
        .order('created_at', { ascending: false })
        .limit(10000)

      if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`)
      if (status) query = query.eq('status', status)

      const { data, error } = await query
      if (error) throw error

      const rows = (data ?? []).map((l: any) => [
        l.id,
        l.name ?? '',
        l.email ?? '',
        l.phone ?? '',
        (l.message ?? '').replace(/"/g, '""'),
        l.source,
        l.status,
        l.created_at,
        l.properties?.title ?? '',
        l.properties?.profiles?.email ?? '',
      ])

      const header = 'id,name,email,phone,message,source,status,created_at,space_title,owner_email'
      const csv = [header, ...rows.map((r: any[]) => r.map((v: any) => `"${v}"`).join(','))].join('\n')

      return reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', 'attachment; filename="viewora-leads.csv"')
        .send(csv)
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to export leads' })
    }
  })

  /**
   * GET /admin/queue/job/:jobId
   * Returns full detail of a specific job (any state) for debugging.
   */
  fastify.get('/queue/job/:jobId', async (request, reply) => {
    try {
      const { jobId } = request.params as any
      const queue = getQueue()
      const job = await queue.getJob(jobId)
      if (!job) return reply.code(404).send({ statusMessage: 'Job not found' })

      const state = await job.getState()
      return reply.send({
        success: true,
        data: {
          jobId: job.id,
          state,
          data: job.data,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason,
          stackTrace: job.stacktrace,
          timestamp: job.timestamp,
          processedOn: job.processedOn,
          finishedOn: job.finishedOn,
        },
      })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch job detail' })
    }
  })

  /**
   * GET /admin/users/:id/subscription-history
   * Returns full subscription record including all fields for support scenarios.
   */
  fastify.get('/users/:id/subscription-history', async (request, reply) => {
    try {
      const { id } = request.params as any
      const { data, error } = await fastify.supabase
        .from('subscriptions')
        .select('*, plans(*)')
        .eq('user_id', id)
        .order('created_at', { ascending: false })
      if (error) throw error
      return reply.send({ success: true, data: data ?? [] })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to fetch subscription history' })
    }
  })
}
