// Normalise a phone number typed by a visitor. Kenyan numbers become
// +2547XXXXXXXX / +2541XXXXXXXX; other countries are accepted in E.164 form
// so diaspora clients can still get a quote.

export type PhoneResult =
  | { ok: true; e164: string; kenyan: boolean }
  | { ok: false; reason: 'empty' | 'too_short' | 'too_long' | 'not_mobile' | 'invalid' }

export function normalisePhone(input: string): PhoneResult {
  const raw = (input ?? '').trim()
  if (!raw) return { ok: false, reason: 'empty' }
  if (/[^\d\s+()\-.]/.test(raw)) return { ok: false, reason: 'invalid' }

  const hasPlus = raw.startsWith('+') || raw.startsWith('00')
  let digits = raw.replace(/\D/g, '')
  if (raw.startsWith('00')) digits = digits.slice(2)

  // Kenyan forms: 07.., 01.., 7.., 1.., 2547.., +2547..
  let national: string | null = null
  if (digits.startsWith('254')) national = digits.slice(3)
  else if (!hasPlus && digits.startsWith('0')) national = digits.slice(1)
  else if (!hasPlus && digits.length === 9) national = digits

  if (national !== null) {
    if (national.startsWith('0')) national = national.slice(1)  // +254 07..
    if (national.length < 9) return { ok: false, reason: 'too_short' }
    if (national.length > 9) return { ok: false, reason: 'too_long' }
    if (!/^[17]/.test(national)) return { ok: false, reason: 'not_mobile' }
    return { ok: true, e164: `+254${national}`, kenyan: true }
  }

  if (!hasPlus) return { ok: false, reason: 'invalid' }
  if (digits.length < 8) return { ok: false, reason: 'too_short' }
  if (digits.length > 15) return { ok: false, reason: 'too_long' }
  return { ok: true, e164: `+${digits}`, kenyan: false }
}
