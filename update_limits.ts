import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function updateLimits() {
  console.log('🔄 Updating plan upload limits...')
  
  const { data, error } = await supabase
    .from('plans')
    .update({ max_upload_bytes: 15728640 }) // 15MB
    .lt('max_upload_bytes', 15728640)

  if (error) {
    console.error('❌ Failed to update limits:', error)
    process.exit(1)
  }

  console.log('✅ Plan limits synchronized to 15MB!')
}

updateLimits()
