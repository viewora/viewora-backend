import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

async function testRpc() {
  const { data, error } = await supabase
    .rpc('get_tour_data', { p_slug: 'tour-8943e9ba' })

  if (error) {
    console.error('RPC Error:', error)
    return
  }

  console.log('RPC Result:', JSON.stringify(data, null, 2))
}

testRpc()
