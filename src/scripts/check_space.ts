import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)

async function check() {
  // Check by space ID first
  const spaceId = '7b8c14db-531c-4902-a866-8286b97d887c'
  console.log(`🔍 Checking space with ID: ${spaceId}`)
  
  const { data: space, error } = await supabase
    .from('properties')
    .select('id, is_published, visibility, slug, title, has_360')
    .eq('id', spaceId)
    .single()

  if (error) {
    console.error('❌ Error fetching space:', error)
    return
  }

  console.log('📋 Space details:', {
    id: space.id,
    title: space.title,
    slug: space.slug,
    is_published: space.is_published,
    visibility: space.visibility,
    has_360: space.has_360
  })

  // Check scenes
  const { data: scenes, error: scenesError } = await supabase
    .from('property_media')
    .select('id, media_type, storage_key, is_primary, created_at')
    .eq('property_id', space.id)
  
  console.log(`\n📷 Scenes (${scenes?.length || 0}):`, scenes?.map((s: any) => ({ id: s.id, type: s.media_type, primary: s.is_primary })))

  // Fix issues
  const issues = []
  if (!space.is_published) issues.push('❌ Space is NOT published')
  if (space.visibility !== 'public') issues.push('❌ Visibility is not public')
  if (!space.has_360 && scenes?.every((s: any) => s.media_type !== 'panorama')) issues.push('❌ No panorama scenes found')

  if (issues.length > 0) {
    console.log('\n⚠️ Issues found:')
    issues.forEach(i => console.log('  ' + i))
    
    console.log('\n🔧 Fixing...')
    const { error: updateErr } = await supabase
      .from('properties')
      .update({ 
        is_published: true,
        visibility: 'public',
        has_360: true 
      })
      .eq('id', space.id)
    
    if (updateErr) {
      console.error('❌ Failed to update:', updateErr)
    } else {
      console.log('✅ Space fixed and published!')
    }
  } else {
    console.log('\n✅ Space looks good!')
  }
}

check()
