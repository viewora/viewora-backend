import type { FastifyInstance } from 'fastify'

// The partner pays for its agents. Each agent gets an ordinary 'manual'
// subscription (the same row "gift subscription" writes) on the partner's
// agent plan, ending on the partner's paid_until. Plan limits, the dashboard
// and the daily expiry job then work unchanged.
//
// A subscription the agent pays for themselves (provider other than
// 'manual') is never overwritten.

export type PartnerPlan = { agent_plan_id: string | null; paid_until: string | null }

export type SyncResult = 'synced' | 'skipped_no_plan' | 'skipped_self_paid' | 'failed'

export async function syncAgentSubscription(fastify: FastifyInstance, plan: PartnerPlan, userId: string): Promise<SyncResult> {
  if (!plan.agent_plan_id || !plan.paid_until) return 'skipped_no_plan'
  const db = fastify.supabase
  const now = new Date().toISOString()
  const active = new Date(plan.paid_until) > new Date()
  const row = {
    plan_id: plan.agent_plan_id,
    status: active ? 'active' : 'expired',
    billing_cycle: 'monthly',
    current_period_end: plan.paid_until,
    provider: 'manual',
    updated_at: now,
  }

  try {
    const { data: existing, error: readErr } = await db.from('subscriptions').select('id, provider').eq('user_id', userId).maybeSingle()
    if (readErr) throw readErr
    if (existing && existing.provider && existing.provider !== 'manual') return 'skipped_self_paid'
    const { error } = existing
      ? await db.from('subscriptions').update(row).eq('user_id', userId)
      : await db.from('subscriptions').insert({ ...row, user_id: userId, current_period_start: now })
    if (error) throw error
  } catch (err: any) {
    fastify.log.error({ err: err?.message, userId }, 'partner agent subscription sync failed')
    return 'failed'
  }

  const redis = (fastify as any).redis
  if (redis) await redis.del(`billing:status:${userId}`).catch(() => {})
  return 'synced'
}

/** Re-applies the partner's plan to every one of its agents (after staff change the plan or paid_until). */
export async function syncPartnerAgents(fastify: FastifyInstance, partnerId: string) {
  const db = fastify.supabase
  const { data: partner, error } = await db.from('api_partners').select('agent_plan_id, paid_until').eq('id', partnerId).maybeSingle()
  if (error || !partner) throw new Error('Partner not found')
  const { data: agents } = await db.from('api_partner_agents').select('user_id').eq('partner_id', partnerId)
  const counts: Record<SyncResult, number> = { synced: 0, skipped_no_plan: 0, skipped_self_paid: 0, failed: 0 }
  for (const a of agents ?? []) counts[await syncAgentSubscription(fastify, partner as PartnerPlan, a.user_id)]++
  return counts
}
