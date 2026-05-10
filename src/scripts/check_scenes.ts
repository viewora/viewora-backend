import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)

async function check() {
  const spaceId = '7b8c14db-531c-4902-a866-8286b97d887c'
  
  const { data: scenes, error } = await supabase
    .from('property_media')
    .select('id, media_type, storage_key, is_primary, processing_status, created_at')
    .eq('property_id', spaceId)
    .order('created_at', { ascending: false })
  
  if (error) {
    console.error('Error:', error)
    return
  }

  console.log('📊 Scene processing status:')
  scenes?.forEach((s: any, i: number) => {
    console.log(`  [${i+1}] ID: ${s.id.substring(0, 8)}... | Status: ${s.processing_status || 'null'} | Primary: ${s.is_primary}`)
  })

  const ready = scenes?.filter((s: any) => s.processing_status === 'ready').length || 0
  console.log(`\n✓ Ready scenes: ${ready} / ${scenes?.length || 0}`)
  
  if (ready === 0) {
    console.log('\n⚠️ WARNING: No scenes are ready! The tour cannot be viewed until scenes finish processing.')
    console.log('   Most likely cause: Scenes were rejected because panorama images are too small.')
    console.log('   Minimum width required: 2000px (you uploaded smaller images)')
  }
}

check()
