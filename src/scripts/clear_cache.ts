import { createClient } from 'redis'
import dotenv from 'dotenv'
dotenv.config()

async function clear() {
  const slug = 'tour-7b8c14db'
  const cacheKey = `tour:${slug}`
  console.log(`🧹 Clearing Redis cache for: ${cacheKey}`)
  
  if (!process.env.REDIS_URL) {
    console.error('❌ REDIS_URL missing')
    return
  }

  const client = createClient({ url: process.env.REDIS_URL })
  await client.connect()
  
  const result = await client.del(cacheKey)
  console.log(result > 0 ? '✅ Cache cleared!' : '⚠️ Cache was already empty.')
  
  await client.quit()
}

clear()
