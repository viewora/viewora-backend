import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)

async function check() {
  const slug = 'tour-761b44a5'
  console.log(`🔍 Checking space with slug: ${slug}`)
  
  const { data: space, error } = await supabase
    .from('properties')
    .select('id, is_published, visibility, slug')
    .eq('slug', slug)
    .single()

  if (error) {
    console.error('Error fetching space:', error)
    return
  }

  console.log('Space details:', space)

  if (space.visibility !== 'public') {
    console.log('⚠️ Visibility is not public. Fixing it...')
    const { error: updateErr } = await supabase
      .from('properties')
      .update({ visibility: 'public' })
      .eq('id', space.id)
    
    if (updateErr) {
      console.error('Failed to update visibility:', updateErr)
    } else {
      console.log('✅ Visibility updated to public!')
    }
  }
}

check()
