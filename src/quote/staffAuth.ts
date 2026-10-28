// Who is calling a staff route, and what their quote-engine role allows.
// Every request must carry the shared admin secret (proves it came from the
// admin server) and X-Admin-Id (the signed-in staff member, already checked
// there against profiles.is_admin). The role comes from qe_staff; admins
// without a staff row can read but not change anything.

import { timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { StaffRole } from './desk.js'
import type { DeskStore } from './deskStore.js'

export type Permission = 'leads:read' | 'leads:write' | 'quotes:write' | 'quotes:approve' | 'rates:read' | 'rates:write'
  | 'jobs:read' | 'jobs:write' | 'payments:write' | 'jobs:export' | 'settings:write' | 'templates:write'
  | 'partners:write' | 'commission:read'

export const PERMISSIONS: Record<Permission, StaffRole[]> = {
  'leads:read': ['admin', 'sales', 'viewer'],
  'leads:write': ['admin', 'sales'],
  'quotes:write': ['admin', 'sales'],
  'quotes:approve': ['admin'],
  'rates:read': ['admin', 'sales', 'viewer'],
  'rates:write': ['admin'],
  'jobs:read': ['admin', 'sales', 'viewer'],
  'jobs:write': ['admin', 'sales'],
  // Recording money by hand and exporting the tracker are admin-only
  'payments:write': ['admin'],
  'jobs:export': ['admin'],
  'settings:write': ['admin'],
  // Wording clients receive
  'templates:write': ['admin'],
  // Partner terms and what they are owed
  'partners:write': ['admin'],
  'commission:read': ['admin'],
}

export interface QuoteStaff {
  id: string
  role: StaffRole
  displayName: string | null
  discountLimitBp: number
}

declare module 'fastify' {
  interface FastifyRequest { quoteStaff?: QuoteStaff }
}

const uuid = z.string().uuid()

export function secretMatches(header: string | undefined): boolean {
  const secret = process.env.ADMIN_SECRET
  if (!secret || !header) return false
  const expected = Buffer.from(`Bearer ${secret}`)
  const given = Buffer.from(header)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export function staffHook(desk: DeskStore) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!secretMatches(request.headers.authorization)) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', statusMessage: 'Unauthorized' })
    }
    const adminId = uuid.safeParse(request.headers['x-admin-id'])
    if (!adminId.success) {
      return reply.code(401).send({ code: 'NO_STAFF_ID', statusMessage: 'Sign in again: your staff identity was missing.' })
    }
    const member = await desk.staff(adminId.data)
    request.quoteStaff = member
      ? { id: member.userId, role: member.role, displayName: member.displayName, discountLimitBp: member.discountLimitBp }
      : { id: adminId.data, role: 'viewer', displayName: null, discountLimitBp: 0 }
  }
}

export function allowed(request: FastifyRequest, reply: FastifyReply, permission: Permission): boolean {
  if (request.quoteStaff && PERMISSIONS[permission].includes(request.quoteStaff.role)) return true
  reply.code(403).send({ code: 'FORBIDDEN', statusMessage: 'Your role cannot do this. Ask an admin to change it.' })
  return false
}
