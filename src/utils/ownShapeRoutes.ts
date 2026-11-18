// Routes whose JSON is returned as written, without the global
// { success, data, meta } envelope added in index.ts:
//  - quote engine: the quote pages read { code, statusMessage, problems } as is
//  - partner API (/v1): a documented, versioned contract for outside developers
//  - /embed-policy: read by the app's embed page as { frame_ancestors }
export function keepsOwnShape(url: string): boolean {
  return /^\/(admin\/)?quote(\/|\?|$)/.test(url)
    || /^\/v1(\/|\?|$)/.test(url)
    || /^\/embed-policy(\/|\?|$)/.test(url)
}

/** Undoes the global envelope on a response body from fastify.inject. */
export function unwrapEnvelope(body: any): any {
  if (body && typeof body === 'object' && body.success === true && 'data' in body) return body.data
  return body
}
