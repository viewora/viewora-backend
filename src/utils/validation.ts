import { FastifyReply } from 'fastify'
import { z } from 'zod'

function getIssuePath(path: PropertyKey[]): string {
  if (path.length === 0) return 'body'
  return path.map((segment) => (typeof segment === 'symbol' ? segment.description || 'symbol' : String(segment))).join('.')
}

export function sendValidationError(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    success: false,
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
    fields: error.issues.map((issue) => ({
      field: getIssuePath(issue.path),
      message: issue.message,
    })),
  })
}

export function parseWithSchema<T>(reply: FastifyReply, schema: z.ZodType<T>, payload: unknown): T | null {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    sendValidationError(reply, parsed.error)
    return null
  }
  return parsed.data
}
