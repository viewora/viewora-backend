import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)

async function fix() {
  console.log('🔍 Finding finished scenes that need status sync...')
  
  const { data: scenes, error } = await supabase
    .from('scenes')
    .select('raw_image_url, id')
    .eq('tiles_ready', true)

  if (error) {
    console.error('Error fetching scenes:', error)
    return
  }

  console.log(`Found ${scenes?.length || 0} finished scenes. Syncing media records...`)

  for (const scene of (scenes || [])) {
    const rawUrl = scene.raw_image_url
    if (!rawUrl) continue;
    
    const storageKey = rawUrl.split('.software/')[1] || rawUrl.split('.dev/')[1]
    
    if (!storageKey) continue

    console.log(`Syncing: ${storageKey}`)
    
    const { error: updateErr } = await supabase
      .from('property_media')
      .update({ processing_status: 'complete' })
      .ilike('storage_key', `%${storageKey}`)

    if (updateErr) {
      console.error(`Failed to sync ${storageKey}:`, updateErr)
    } else {
      console.log(`✅ Synced ${storageKey}`)
    }
  }
  
  console.log('🚀 Sync complete!')
}

fix()
