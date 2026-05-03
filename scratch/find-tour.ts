import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

async function findTour() {
  const { data, error } = await supabase
    .from('properties')
    .select('id, title, slug, is_published')
    .ilike('slug', '%8943e9ba%')

  if (error) {
    console.error(error)
    return
  }

  console.log('Results:', JSON.stringify(data, null, 2))
}

findTour()
