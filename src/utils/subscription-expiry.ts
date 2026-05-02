import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Mark subscriptions whose billing period has ended as 'expired'.
 * Called daily by a BullMQ repeatable job so the status stays accurate
 * even when Paystack webhooks are delayed or missed.
 */
export async function expireStaleSubscriptions(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from('subscriptions')
    .update({ status: 'expired' })
    .eq('status', 'active')
    .lt('current_period_end', new Date().toISOString())
    .select('id')

  if (error) throw error
  return data?.length ?? 0
}
