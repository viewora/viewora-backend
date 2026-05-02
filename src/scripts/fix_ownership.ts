import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)

async function fix() {
  const spaceId = '00a6bbdf-b975-45f2-b96f-f4fc4a8ddb24'
  console.log(`🔍 Checking owner for space: ${spaceId}`)
  
  const { data: space, error } = await supabase
    .from('properties')
    .select('id, user_id, title')
    .eq('id', spaceId)
    .single()

  if (error) {
    console.error('Error fetching space:', error)
    return
  }

  console.log('Current Owner ID:', space.user_id)
  console.log('Space Title:', space.title)

  // You mentioned using 'mock-user-id' in your global rules
  const targetUserId = 'mock-user-id' 

  if (space.user_id !== targetUserId) {
    console.log(`⚠️ Owner mismatch. Changing owner to: ${targetUserId}`)
    const { error: updateErr } = await supabase
      .from('properties')
      .update({ user_id: targetUserId })
      .eq('id', spaceId)
    
    if (updateErr) {
      console.error('Failed to update owner:', updateErr)
    } else {
      console.log('✅ Ownership transferred! You can now edit this tour.')
    }
  } else {
    console.log('✅ Ownership is already correct.')
  }
}

fix()
