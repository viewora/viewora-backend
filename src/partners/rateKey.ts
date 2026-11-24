import type { FastifyRequest } from 'fastify'
import { hashPartnerKey } from '../utils/partnerKeys.js'

/** Rate-limit bucket: the partner key (hashed), or the IP for requests without one. */
export function rateKey(req: FastifyRequest) {
  const auth = req.headers.authorization
  return typeof auth === 'string' && auth.startsWith('Bearer vo_') ? `pk:${hashPartnerKey(auth.slice(7).trim()).slice(0, 24)}` : req.ip
}
