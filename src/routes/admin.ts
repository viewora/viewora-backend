import { FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'crypto'
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

      // Cascade: delete all spaces (media cascades via DB FK), subscriptions, counters, notes
      await fastify.supabase.from('admin_notes').delete().eq('user_id', id)
      await fastify.supabase.from('subscriptions').delete().eq('user_id', id)
      await fastify.supabase.from('usage_counters').delete().eq('user_id', id)

      // Delete all spaces and their media (soft-cascaded by properties FK)
      const { data: userSpaces } = await fastify.supabase
        .from('properties').select('id').eq('user_id', id)
      if (userSpaces?.length) {
        const spaceIds = userSpaces.map((s: any) => s.id)
        await fastify.supabase.from('properties').delete().in('id', spaceIds)
      }

      await fastify.supabase.from('profiles').delete().eq('id', id)

      // Delete Supabase auth user
      const { error: authError } = await fastify.supabase.auth.admin.deleteUser(id)
      if (authError) fastify.log.warn({ id, authError }, 'Failed to delete Supabase auth user — profile already deleted')

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
        .from('profiles').select('email').eq('id', id).single()
      if (!profile?.email) return reply.code(404).send({ statusMessage: 'User email not found' })

      const { error } = await fastify.supabase.auth.admin.generateLink({
        type: 'recovery',
        email: profile.email,
      })
      if (error) throw error

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
    const { body: noteBody, adminId } = request.body as any
    if (!noteBody?.trim()) return reply.code(400).send({ statusMessage: 'Note body required' })
    if (!adminId) return reply.code(400).send({ statusMessage: 'adminId required' })

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
      const { data: dbKeys } = await fastify.supabase
        .from('property_media').select('storage_key')
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

  // ── PLANS ──────────────────────────────────────────────────────────────────

  fastify.get('/plans', async (_request, reply) => {
    try {
      const { data: plans } = await fastify.supabase
        .from('plans').select('*').order('price_monthly_kes', { ascending: true })

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

  fastify.post('/plans', async (request, reply) => {
    try {
      const body = request.body as any
      const { data, error } = await fastify.supabase.from('plans').insert(body).select().single()
      if (error) throw error
      await auditLog(fastify, request, 'create_plan', 'plan', data.id, body)
      return reply.code(201).send({ success: true, data })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to create plan' })
    }
  })

  fastify.patch('/plans/:id', async (request, reply) => {
    try {
      const { id } = request.params as any
      const body = request.body as any
      const { data, error } = await fastify.supabase
        .from('plans').update({ ...body, updated_at: new Date().toISOString() }).eq('id', id).select().single()
      if (error) throw error
      await auditLog(fastify, request, 'update_plan', 'plan', id, body)
      return reply.send({ success: true, data })
    } catch (error: any) {
      return reply.code(500).send({ statusMessage: 'Failed to update plan' })
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
}
