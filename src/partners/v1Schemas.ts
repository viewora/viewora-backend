import { z } from 'zod'
import { UPLOAD_KINDS } from './tourGateway.js'

// Request schemas for the /v1 agents, tours and uploads routes. They live here
// so the API (routes/partnerApi.ts) and the published reference (openapi.ts)
// read the same rules.

export const EXTERNAL_ID = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:\-]+$/, 'Use letters, numbers, dot, dash, underscore or colon')
export const SPACE_TYPES = ['residential', 'commercial', 'hospitality', 'education', 'automotive', 'land', 'other'] as const
export const FACT_KEYS = [
  'price_kes', 'listing_status', 'transaction_type', 'price_period', 'bedrooms', 'bathrooms', 'area_sqm',
  'vehicle_year', 'vehicle_mileage_km', 'vehicle_transmission', 'vehicle_fuel_type', 'land_acres', 'land_type', 'amenities',
] as const

export const createAgentBody = z.object({
  external_id: EXTERNAL_ID,
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(255).optional(),
})

export const createTourBody = z.object({
  agent_external_id: EXTERNAL_ID,
  external_id: EXTERNAL_ID,
  title: z.string().trim().min(1).max(120),
  type: z.enum(SPACE_TYPES),
  description: z.string().max(2000).optional(),
  location_text: z.string().max(200).optional(),
  // Listing facts are checked by the same rules as the dashboard.
  details: z.record(z.string(), z.unknown()).optional(),
})

export const listQuery = z.object({
  external_id: EXTERNAL_ID.optional(),
  agent_external_id: EXTERNAL_ID.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
})

export const tourParams = z.object({ id: z.string().uuid() })
export const agentParams = z.object({ externalId: EXTERNAL_ID })

export const createUploadBody = z.object({
  kind: z.enum(UPLOAD_KINDS),
  file_name: z.string().trim().min(1).max(255),
  content_type: z.string().trim().min(1).max(120),
  file_size: z.number().int().positive().max(250_000_000),
})

export const completeUploadBody = z.object({
  kind: z.enum(UPLOAD_KINDS),
  upload_key: z.string().trim().min(1).max(512),
  name: z.string().trim().min(1).max(100).optional(),
  angle: z.number().int().min(0).max(359).optional(),
  width: z.number().int().positive().max(20000).optional(),
  height: z.number().int().positive().max(20000).optional(),
}).superRefine((d, ctx) => {
  if (d.kind === 'car_exterior' && d.angle === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['angle'], message: 'angle (0–359) is required for car_exterior photos' })
  }
})
