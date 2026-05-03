import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'

// Load env from backend directory
dotenv.config()

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function fixMissingThumbnails() {
  console.log('Fetching properties missing cover images...')
  
  const { data: props, error: propErr } = await supabase
    .from('properties')
    .select('id, title')
    .or('cover_image_url.is.null,cover_image_url.eq.""')

  if (propErr) {
    console.error('Error fetching properties:', propErr)
    return
  }

  console.log(`Found ${props.length} properties to check.`)

  for (const prop of props) {
    console.log(`Checking scenes for "${prop.title}" (${prop.id})...`)
    
    const { data: scenes, error: sceneErr } = await supabase
      .from('scenes')
      .select('thumbnail_url')
      .eq('space_id', prop.id)
      .eq('status', 'ready')
      .not('thumbnail_url', 'is', null)
      .order('created_at', { ascending: true })
      .limit(1)

    if (sceneErr) {
      console.error(`Error fetching scenes for ${prop.id}:`, sceneErr)
      continue
    }

    if (scenes && scenes.length > 0) {
      const thumb = scenes[0].thumbnail_url
      console.log(`Found thumbnail: ${thumb}. Updating property...`)
      
      const { error: updateErr } = await supabase
        .from('properties')
        .update({ cover_image_url: thumb, has_360: true })
        .eq('id', prop.id)

      if (updateErr) {
        console.error(`Error updating property ${prop.id}:`, updateErr)
      } else {
        console.log(`Successfully updated "${prop.title}".`)
      }
    } else {
      console.log(`No ready scenes with thumbnails found for "${prop.title}".`)
    }
  }

  console.log('Done.')
}

fixMissingThumbnails()
