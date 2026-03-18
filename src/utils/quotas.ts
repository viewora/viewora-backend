import { FastifyInstance } from 'fastify'

export async function checkUserQuota(fastify: FastifyInstance, userId: string) {
  // 1. Get user's subscription and plan details
  const { data: sub, error: subError } = await fastify.supabase
    .from('subscriptions')
    .select('*, plans(*)')
    .eq('user_id', userId)
    .single()

  if (subError || !sub) {
    // Fallback to Free Plan if no subscription exists
    const { data: freePlan, error: planError } = await fastify.supabase
      .from('plans')
      .select('*')
      .eq('name', 'Free')
      .single()
    
    if (planError || !freePlan) throw new Error('Could not find free plan')
    
    return { 
      plan: freePlan, 
      subscription: null,
      isTrial: true
    }
  }

  return {
    plan: sub.plans,
    subscription: sub,
    isTrial: sub.status === 'trialing'
  }
}

export async function canCreateProperty(fastify: FastifyInstance, userId: string) {
  const { plan } = await checkUserQuota(fastify, userId)
  
  // Get current property count
  const { data: counter, error: counterError } = await fastify.supabase
    .from('usage_counters')
    .select('active_properties_count')
    .eq('user_id', userId)
    .single()

  if (counterError || !counter) return false

  return counter.active_properties_count < plan.max_active_properties
}

export async function checkStorageQuota(fastify: FastifyInstance, userId: string, newFileSize: number) {
  const { plan } = await checkUserQuota(fastify, userId)
  
  // Get current storage usage
  const { data: counter, error: counterError } = await fastify.supabase
    .from('usage_counters')
    .select('storage_used_bytes')
    .eq('user_id', userId)
    .single()

  if (counterError || !counter) return false

  const currentUsage = Number(counter.storage_used_bytes || 0)
  const maxBytes = Number(plan.max_storage_bytes || 0)

  return (currentUsage + newFileSize) <= maxBytes
}

export function isValidFileType(contentType: string, mediaType: string) {
  const allowedImages = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
  
  if (['panorama', 'gallery', 'thumb', 'logo'].includes(mediaType)) {
    return allowedImages.includes(contentType)
  }
  
  return false
}
