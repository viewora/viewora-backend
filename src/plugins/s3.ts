import { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { S3Client } from '@aws-sdk/client-s3'

declare module 'fastify' {
  interface FastifyInstance {
    s3: S3Client
  }
}

export default fp(async (fastify: FastifyInstance) => {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY

  if (!accountId || !accessKeyId || !secretAccessKey) {
    fastify.log.error('Missing Cloudflare R2 environment variables')
    throw new Error('Missing R2 configuration')
  }

  // Cloudflare R2 uses the S3-compatible API.
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey
    }
  })

  fastify.decorate('s3', s3)
})
