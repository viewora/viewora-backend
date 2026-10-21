import { FastifyInstance } from 'fastify'
import { checkUserQuota } from './quotas.js'

// Monthly AI allowances per plan (plans.ai_prompts_per_month / ai_image_edits_per_month,
// see migration-add-ai-assistant.sql). NULL = unlimited, 0 = off.

export type AiKind = 'prompts' | 'image_edits'

export type AiAllowance = { used: number; limit: number | null }

export type AiUsageSummary = {
  period:     string
  planName:   string
  isFree:     boolean
  prompts:    AiAllowance
  imageEdits: AiAllowance
}

export function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7)   // 'YYYY-MM' (UTC)
}

async function planLimits(fastify: FastifyInstance, userId: string) {
  const quota = await checkUserQuota(fastify, userId)
  let plan = quota.plan
  // The billing:status Redis cache may hold a plan row from before the AI columns existed
  if (plan.ai_prompts_per_month === undefined && plan.id) {
    const { data } = await fastify.supabase
      .from('plans')
      .select('ai_prompts_per_month, ai_image_edits_per_month')
      .eq('id', plan.id)
      .single()
    plan = { ...plan, ...(data ?? {}) }
  }
  const read = (v: unknown, fallback: number): number | null =>
    v === null ? null : typeof v === 'number' ? v : fallback
  return {
    quota,
    prompts:     read(plan.ai_prompts_per_month, 20),
    image_edits: read(plan.ai_image_edits_per_month, 0),
  }
}

export async function getAiUsage(fastify: FastifyInstance, userId: string): Promise<AiUsageSummary> {
  const period = currentPeriod()
  const [limits, { data: row }] = await Promise.all([
    planLimits(fastify, userId),
    fastify.supabase.from('ai_usage').select('prompts, image_edits').eq('user_id', userId).eq('period', period).maybeSingle(),
  ])
  return {
    period,
    planName:   limits.quota.plan.name || 'Free',
    isFree:     limits.quota.isFree,
    prompts:    { used: row?.prompts ?? 0,     limit: limits.prompts },
    imageEdits: { used: row?.image_edits ?? 0, limit: limits.image_edits },
  }
}

export class AiLimitError extends Error {
  constructor(public kind: AiKind, public limit: number, public planName: string) {
    super(
      kind === 'image_edits'
        ? (limit === 0
            ? `AI photo editing isn't included in the ${planName} plan. Upgrade to remove or add objects in your photos.`
            : `You've used all ${limit} AI photo edits for this month on the ${planName} plan.`)
        : `You've used all ${limit} AI requests for this month on the ${planName} plan.`,
    )
  }
}

/**
 * Counts one use before the AI call (atomic, so parallel requests can't overshoot).
 * Returns a refund function to call if the AI call then fails.
 */
export async function consumeAi(fastify: FastifyInstance, userId: string, kind: AiKind): Promise<() => Promise<void>> {
  const limits = await planLimits(fastify, userId)
  const limit  = limits[kind]
  const period = currentPeriod()
  if (limit === 0) throw new AiLimitError(kind, 0, limits.quota.plan.name || 'Free')

  const { data, error } = await fastify.supabase.rpc('consume_ai_usage', {
    p_user: userId, p_period: period, p_kind: kind, p_limit: limit,
  })
  if (error) throw new Error(`AI usage check failed: ${error.message}`)
  if (data === -1) throw new AiLimitError(kind, limit ?? 0, limits.quota.plan.name || 'Free')

  return async () => {
    await fastify.supabase.rpc('refund_ai_usage', { p_user: userId, p_period: period, p_kind: kind })
  }
}
