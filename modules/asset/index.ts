// Asset module — owns all upload-related logic.
//
// Current state: upload routes live in src/routes/uploads.ts (production-ready).
// V1 goal: migrate those routes into this module for better boundary separation.
//
// Responsibilities of this module:
//   - Generate presigned R2 upload URLs (POST /uploads/create-signed-url)
//   - Register completed uploads (POST /uploads/complete)
//   - Retry failed media processing (POST /uploads/:id/retry-processing)
//   - Delete media objects from R2 + database (DELETE /uploads/:id)
//   - EXIF metadata stripping before or after R2 write (V1 TODO)
//
// Security invariants (enforced in src/routes/uploads.ts today — must carry over):
//   - Ownership verified before signed URL generation (.eq('user_id', userId))
//   - objectKey prefix validated on /complete (startsWith 'users/${userId}/')
//   - Quota + subscription checked on every upload
//   - File type whitelist: JPEG, PNG, WebP only
//
// EXIF stripping status: NOT YET IMPLEMENTED.
//   Mark: strip EXIF in media-processor.ts after R2 write, before setting processing_status='ready'.
//   Library to use: sharp (already used for tile processing) — strip metadata with .withMetadata(false).

import type { FastifyInstance } from 'fastify'

export default async function assetModule(fastify: FastifyInstance) {
  // Placeholder — upload routes will be migrated here from src/routes/uploads.ts in V1
}
