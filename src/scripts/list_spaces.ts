import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)

async function list() {
  console.log('📋 Listing all tours in the database...')
  
  const { data: spaces, error } = await supabase
    .from('properties')
    .select('id, title, slug, is_published, user_id')

  if (error) {
    console.error('Error fetching spaces:', error)
    return
  }

  console.table(spaces)
}

list()
