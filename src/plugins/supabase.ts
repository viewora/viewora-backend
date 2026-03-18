import { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

declare module 'fastify' {
  interface FastifyInstance {
    supabase: SupabaseClient
  }
}

export default fp(async (fastify: FastifyInstance) => {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    fastify.log.error('Missing Supabase environment variables')
    throw new Error('Missing Supabase configuration')
  }

  // We use the Service Role Key because the backend needs to perform 
  // administrative tasks (like updating subscriptions) that bypass RLS.
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  })

  fastify.decorate('supabase', supabase)
})
