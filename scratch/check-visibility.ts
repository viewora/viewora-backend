import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

async function checkVisibility() {
  const { data, error } = await supabase
    .from('properties')
    .select('id, title, slug, is_published, visibility')
    .eq('slug', 'tour-8943e9ba')

  if (error) {
    console.error(error)
    return
  }

  console.log('Results:', JSON.stringify(data, null, 2))
}

checkVisibility()
