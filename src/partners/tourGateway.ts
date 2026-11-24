import type { FastifyInstance } from 'fastify'
import { unwrapEnvelope } from '../utils/ownShapeRoutes.js'
import type { CarIdentity, SpaceFacts } from './listingModel.js'
import type { PartnerStore } from './store.js'

// The listing API never writes the tour (properties) row itself. Every tour
// change runs AS the agent through the existing dashboard routes, so plan
// limits, quotas, file checks and cache clearing stay exactly the same.

export type InternalResult = { status: number; body: any }
export type CallAs = (userId: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => Promise<InternalResult>

/** Runs a route in-process as the agent, with the internal key. */
export function makeCallAs(fastify: FastifyInstance): CallAs {
  return async (userId, method, url, payload) => {
    const res = await fastify.inject({
      method,
      url,
      payload: payload as any,
      // Gives each agent its own bucket in the existing per-route rate limits.
      remoteAddress: `partner-agent:${userId}`,
      headers: {
        'x-internal-api-key': process.env.INTERNAL_API_KEY as string,
        'x-internal-user-id': userId,
      },
    })
    let body: any = {}
    try { body = res.json() } catch { body = {} }
    return { status: res.statusCode, body: unwrapEnvelope(body) }
  }
}

export const UPLOAD_KINDS = ['panorama', 'photo', 'car_exterior'] as const
export type UploadKind = typeof UPLOAD_KINDS[number]
export const KIND_TO_MEDIA: Record<UploadKind, string> = {
  panorama: 'panorama',
  photo: 'gallery_image',
  car_exterior: 'vehicle_view',
}

export type GatewayError = { ok: false; status: number; code: string; message: string }
const err = (res: InternalResult, fallback: string): GatewayError => ({
  ok: false,
  status: res.status >= 400 ? res.status : 502,
  code: res.body?.code || res.body?.error?.code || 'TOUR_UPDATE_FAILED',
  message: res.body?.statusMessage || res.body?.error?.message || (typeof res.body?.message === 'string' ? res.body.message : null) || fallback,
})

export type CompleteUpload = {
  spaceId: string; kind: UploadKind; uploadKey: string; publicUrl: string
  name?: string; angle?: number; width?: number; height?: number
}

/**
 * Finishes an upload that is already in R2: records it, and turns a
 * panorama into a 360 scene or a car_exterior photo into a spin photo.
 * Safe to repeat (the existing routes de-duplicate on client_event_id and
 * the store checks below).
 */
export async function completeUpload(callAs: CallAs, store: PartnerStore, userId: string, u: CompleteUpload):
  Promise<{ ok: true; mediaId: string | null; viewId: string | null } | GatewayError> {
  const done = await callAs(userId, 'POST', '/uploads/complete', {
    spaceId: u.spaceId,
    mediaType: KIND_TO_MEDIA[u.kind],
    objectKey: u.uploadKey,
    publicUrl: u.publicUrl,
    width: u.width,
    height: u.height,
    client_event_id: `partner:${u.uploadKey}`.slice(0, 255),
  })
  if (done.status !== 200) return err(done, 'Could not finish the upload.')
  const mediaId = (done.body?.id as string | undefined) ?? null
  let viewId: string | null = null

  if (u.kind === 'panorama' && !(await store.sceneExists(u.spaceId, u.publicUrl))) {
    const scene = await callAs(userId, 'POST', `/spaces/${u.spaceId}/scenes`, { name: u.name ?? 'Scene', raw_image_url: u.publicUrl })
    if (scene.status !== 201) return err(scene, 'The file was saved but could not be turned into a 360 scene.')
  }
  if (u.kind === 'car_exterior' && !(await store.vehicleViewExists(u.spaceId, u.publicUrl))) {
    const view = await callAs(userId, 'POST', `/spaces/${u.spaceId}/vehicle-views`, {
      image_url: u.publicUrl, media_id: mediaId, angle: u.angle, label: u.name ?? null,
      width: u.width ?? null, height: u.height ?? null,
    })
    if (view.status !== 201) return err(view, 'The file was saved but could not be added to the car.')
    viewId = view.body?.vehicle_view?.id ?? null
  }
  return { ok: true, mediaId, viewId }
}

export interface TourGateway {
  createSpace(userId: string, facts: SpaceFacts): Promise<{ ok: true; id: string } | GatewayError>
  updateSpace(userId: string, spaceId: string, facts: SpaceFacts): Promise<{ ok: true } | GatewayError>
  deleteSpace(userId: string, spaceId: string): Promise<void>
  setCarIdentity(userId: string, spaceId: string, identity: CarIdentity): Promise<{ ok: true } | GatewayError>
  setPublished(userId: string, spaceId: string, publish: boolean): Promise<{ ok: true } | GatewayError>
  /** Downloads nothing: the bytes are already fetched. Puts them in R2 and records them on the tour. */
  uploadFile(userId: string, spaceId: string, file: { kind: UploadKind; bytes: Buffer; contentType: string; fileName: string; angle?: number | null; caption?: string | null }):
    Promise<{ ok: true; mediaId: string | null; viewId: string | null } | GatewayError>
  removeMedia(userId: string, media: { space_media_id: string | null; vehicle_view_id: string | null }): Promise<void>
}

/** create accepts no nulls for text fields; update clears them with null. */
function forCreate(f: SpaceFacts) {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null && v !== undefined))
}

export function callAsGateway(callAs: CallAs, store: PartnerStore, mediaBase: string, put: typeof fetch = fetch): TourGateway {
  return {
    async createSpace(userId, facts) {
      const res = await callAs(userId, 'POST', '/spaces', forCreate(facts))
      return res.status === 201 && res.body?.id ? { ok: true, id: res.body.id } : err(res, 'Could not create the tour.')
    },
    async updateSpace(userId, spaceId, facts) {
      const res = await callAs(userId, 'PATCH', `/spaces/${spaceId}`, facts)
      return res.status === 200 ? { ok: true } : err(res, 'Could not update the tour.')
    },
    async deleteSpace(userId, spaceId) {
      const res = await callAs(userId, 'DELETE', `/spaces/${spaceId}`)
      // Already gone is fine; anything else must not be mistaken for a deletion.
      if (res.status >= 400 && res.status !== 404) throw new Error(`delete tour ${spaceId}: ${res.status}`)
    },
    async setCarIdentity(userId, spaceId, identity) {
      const res = await callAs(userId, 'PATCH', `/spaces/${spaceId}/vehicle-identity`, identity)
      return res.status === 200 ? { ok: true } : err(res, 'Could not save the car details.')
    },
    async setPublished(userId, spaceId, publish) {
      const res = await callAs(userId, 'POST', `/spaces/${spaceId}/publish`, { publish })
      return res.status === 200 ? { ok: true } : err(res, publish ? 'Could not publish the tour.' : 'Could not unpublish the tour.')
    },
    async uploadFile(userId, spaceId, file) {
      const start = await callAs(userId, 'POST', '/uploads/create-signed-url', {
        spaceId, mediaType: KIND_TO_MEDIA[file.kind], fileName: file.fileName, contentType: file.contentType, fileSize: file.bytes.length,
      })
      if (start.status !== 200) return err(start, 'Could not start the upload.')
      const res = await put(start.body.signedUrl, { method: 'PUT', body: file.bytes as any, headers: { 'Content-Type': file.contentType } })
      if (!res.ok) return { ok: false, status: 502, code: 'STORAGE_UNAVAILABLE', message: `Storage refused the file (${res.status}).` }
      const key = start.body.objectKey as string
      return completeUpload(callAs, store, userId, {
        spaceId, kind: file.kind, uploadKey: key, publicUrl: `${mediaBase}/${key}`,
        name: file.caption ?? undefined, angle: file.angle ?? undefined,
      })
    },
    async removeMedia(userId, m) {
      if (m.vehicle_view_id) await callAs(userId, 'DELETE', `/vehicle-views/${m.vehicle_view_id}`)
      if (m.space_media_id) await callAs(userId, 'DELETE', `/uploads/${m.space_media_id}`)
    },
  }
}
