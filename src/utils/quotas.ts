import { FastifyInstance } from 'fastify'

// Statuses that allow uploading and publishing new content
const ACTIVE_STATUSES = ['active', 'trialing', 'trial'] as const

// Statuses that allow reading/viewing but block new uploads and publishing
const GRACE_STATUSES = ['grace_period', 'past_due'] as const

type SubStatus = typeof ACTIVE_STATUSES[number] | typeof GRACE_STATUSES[number] | 'expired' | 'canceled' | 'unpaid' | 'pending_payment'

export interface QuotaContext {
  plan: Record<string, any>
  subscription: Record<string, any> | null
  /** true when user can upload and publish */
  canWrite: boolean
  /** true when user is in grace period (reads OK, writes blocked) */
  isGrace: boolean
  /** true when user has no paid subscription at all */
  isFree: boolean
}

export async function checkUserQuota(fastify: FastifyInstance, userId: string): Promise<QuotaContext> {
  // Read from the billing:status Redis cache (same key written by GET /billing/status,
  // invalidated by billing webhooks and space create/delete). Avoids 2 DB queries on
  // every upload, space create, publish, and dashboard load.
  const redis = (fastify as any).redis as ReturnType<typeof import('redis').createClient> | null
  if (redis) {
    try {
      const cached = await redis.get(`billing:status:${userId}`)
      if (cached) {
        const { subscription: sub, plan } = JSON.parse(cached) as { subscription: any; plan: any }
        if (plan) {
          const status = sub?.status as SubStatus | undefined
          let effectiveStatus = status
          if (status === 'grace_period' && sub?.grace_period_ends_at) {
            if (new Date(sub.grace_period_ends_at) < new Date()) effectiveStatus = 'expired' as SubStatus
          }
          const canWrite = effectiveStatus ? (ACTIVE_STATUSES as readonly string[]).includes(effectiveStatus) : true
          const isGrace = effectiveStatus ? (GRACE_STATUSES as readonly string[]).includes(effectiveStatus) : false
          return { plan, subscription: sub || null, canWrite, isGrace, isFree: !sub }
        }
      }
    } catch { /* fall through to DB */ }
  }

  const { data: sub, error: subError } = await fastify.supabase
    .from('subscriptions')
    .select('*, plans(*)')
    .eq('user_id', userId)
    .single()

  if (subError || !sub) {
    // No subscription — fall back to Free plan limits
    const { data: freePlan, error: planError } = await fastify.supabase
      .from('plans')
      .select('*')
      .eq('name', 'Free')
      .single()

    if (planError || !freePlan) throw new Error('Free plan not found in database')

    return {
      plan: {
        ...freePlan,
        max_active_spaces: freePlan.max_active_properties,
        max_active_properties: undefined
      },
      subscription: null,
      canWrite: true,
      isGrace: false,
      isFree: true,
    }
  }

  const status = sub.status as SubStatus

  // Grace period: check if the grace window has already expired
  let effectiveStatus = status
  if (status === 'grace_period' && sub.grace_period_ends_at) {
    const graceEnds = new Date(sub.grace_period_ends_at)
    if (graceEnds < new Date()) {
      effectiveStatus = 'expired'
    }
  }

  const canWrite = (ACTIVE_STATUSES as readonly string[]).includes(effectiveStatus)
  const isGrace = (GRACE_STATUSES as readonly string[]).includes(effectiveStatus)

  return {
    plan: {
      ...sub.plans,
      max_active_spaces: sub.plans.max_active_properties,
      max_active_properties: undefined
    },
    subscription: sub,
    canWrite,
    isGrace,
    isFree: false,
  }
}

export async function canCreateSpace(fastify: FastifyInstance, userId: string, quota?: QuotaContext): Promise<boolean> {
  const { plan } = quota ?? await checkUserQuota(fastify, userId)

  const { data: counter } = await fastify.supabase
    .from('usage_counters')
    .select('active_properties_count')
    .eq('user_id', userId)
    .single()

  const currentCount = counter?.active_properties_count || 0
  return currentCount < plan.max_active_spaces
}

export async function checkStorageQuota(
  fastify: FastifyInstance,
  userId: string,
  newFileSize: number,
  existingPlan?: Record<string, any>,
): Promise<boolean> {
  const plan = existingPlan ?? (await checkUserQuota(fastify, userId)).plan

  const { data: counter } = await fastify.supabase
    .from('usage_counters')
    .select('storage_used_bytes')
    .eq('user_id', userId)
    .single()

  const currentUsage = Number(counter?.storage_used_bytes || 0)
  const maxBytes = Number(plan.max_storage_bytes || 0)

  return (currentUsage + newFileSize) <= maxBytes
}

/** Check single-file size against plan's per-upload limit */
export function checkFileSizeLimit(plan: Record<string, any>, fileSize: number): boolean {
  const maxUpload = Number(plan.max_upload_bytes || 262144000) // default 250 MB
  return fileSize <= maxUpload
}

export function isValidFileType(contentType: string, mediaType: string): boolean {
  const allowedImages = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']

  if (['panorama', 'gallery', 'gallery_image', 'thumb', 'thumbnail', 'logo', 'branding_logo', 'floor_plan'].includes(mediaType)) {
    return allowedImages.includes(contentType)
  }

  if (mediaType === 'audio') {
    return ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/mp4'].includes(contentType)
  }

  return false
}
