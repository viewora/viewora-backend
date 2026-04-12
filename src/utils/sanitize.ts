export function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim()
}

export function sanitizeLeadText(input: string, maxLength: number): string {
  return stripHtml(input).slice(0, maxLength)
}

export function sanitizeLeadPhone(input?: string): string | null {
  if (!input) return null
  const value = input.replace(/[^\d\s+\-()]/g, '').trim().slice(0, 20)
  return value.length > 0 ? value : null
}
