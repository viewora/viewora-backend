// The quote as a PDF (A4), drawn from the same client view the quote page
// uses. Inter is embedded so prices use tabular figures and a real minus.

import PDFDocument from 'pdfkit'
import { render } from './alerts.js'
import { formatKes } from './desk.js'
import { INTER_REGULAR, INTER_SEMIBOLD } from './pdfFonts.js'
import type { PublicOption, PublicQuote } from './publicQuote.js'
import { quoteStringsEn, type QuoteStrings } from './strings/quote.en.js'

const INK = '#141414'
const DIM = '#5c5c5c'
const RULE = '#dcdcdc'
const M = 48                     // page margin
const W = 595.28 - M * 2         // A4 width inside the margins
const COLS = { qty: 300, unit: 350, amount: 430 }   // x offsets inside the content box

const longDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Nairobi' })

export function renderQuotePdf(quote: PublicQuote, opts: { whatsapp: string; strings?: QuoteStrings }): Promise<Buffer> {
  const t = opts.strings ?? quoteStringsEn
  const money = (n: number) => formatKes(n, quote.currency)
  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: `${t.title} ${quote.ref ?? ''}`.trim(), Author: t.brand } })
  doc.registerFont('r', INTER_REGULAR)
  doc.registerFont('b', INTER_SEMIBOLD)
  const num = { features: ['tnum'] as any }

  const chunks: Buffer[] = []
  doc.on('data', c => chunks.push(c))
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  const ensure = (height: number) => { if (doc.y + height > doc.page.height - M - 40) doc.addPage() }
  const rule = (color = RULE) => { doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.6).strokeColor(color).stroke() }

  // Header
  doc.font('b').fontSize(18).fillColor(INK).text(t.brand, M, M)
  doc.font('b').fontSize(11).text(t.title, M, M + 4, { width: W, align: 'right' })
  doc.font('r').fontSize(9).fillColor(DIM).text(`${t.reference} ${quote.ref}`, M, M + 20, { width: W, align: 'right', ...num })
  doc.moveDown(2)
  const prepared = quote.firstName ? render(t.preparedFor, { name: quote.firstName, industry: quote.industry ?? '' }) : quote.industry ?? ''
  doc.font('r').fontSize(12).fillColor(INK).text(prepared, M)
  doc.moveDown(0.4)
  const meta = [
    quote.sentAt ? `${t.date}: ${longDate(quote.sentAt)}` : null,
    quote.validUntil ? `${t.validUntil}: ${longDate(quote.validUntil)}` : null,
    quote.vatCharged ? render(t.vatIncluded, { rate: String((quote.vatRateBp ?? 0) / 100) }) : t.vatExcluded,
  ].filter(Boolean).join('   ·   ')
  doc.font('r').fontSize(9).fillColor(DIM).text(meta, M, doc.y, { width: W })
  if (quote.state === 'expired' && quote.validUntil) {
    doc.moveDown(0.6)
    doc.font('b').fontSize(10).fillColor(INK).text(render(t.expired, { date: longDate(quote.validUntil) }), M, doc.y, { width: W })
  }
  doc.moveDown(1.2)

  if (quote.clientNote) {
    doc.font('b').fontSize(10).fillColor(INK).text(t.noteHeading, M)
    doc.moveDown(0.2)
    doc.font('r').fontSize(10).fillColor(INK).text(quote.clientNote, M, doc.y, { width: W })
    doc.moveDown(1.2)
  }

  const option = (o: PublicOption) => {
    ensure(120 + o.lines.length * 16)
    const top = doc.y
    doc.font('b').fontSize(13).fillColor(INK).text(t.tiers[o.tier] ?? o.tier, M, top)
    if (o.recommended && (quote.options?.length ?? 0) > 1) {
      doc.font('r').fontSize(9).fillColor(DIM).text(t.recommended, M + 110, top + 3)
    }
    doc.font('b').fontSize(13).fillColor(INK).text(money(o.total), M, top, { width: W, align: 'right', ...num })
    doc.moveDown(0.6)

    const head = doc.y
    doc.font('r').fontSize(8.5).fillColor(DIM)
    doc.text(t.item, M, head)
    doc.text(t.qty, M + COLS.qty, head, { width: 40, align: 'right' })
    doc.text(t.unit, M + COLS.unit, head, { width: 70, align: 'right' })
    doc.text(t.amount, M + COLS.amount, head, { width: W - COLS.amount, align: 'right' })
    doc.moveDown(0.3)
    rule()
    doc.moveDown(0.4)

    for (const l of o.lines) {
      ensure(18)
      const y = doc.y
      doc.font('r').fontSize(9.5).fillColor(INK)
      doc.text(l.label, M, y, { width: COLS.qty - 12 })
      const after = doc.y
      doc.text(String(l.qty), M + COLS.qty, y, { width: 40, align: 'right', ...num })
      doc.text(money(l.unit), M + COLS.unit, y, { width: 70, align: 'right', ...num })
      doc.text(money(l.amount), M + COLS.amount, y, { width: W - COLS.amount, align: 'right', ...num })
      doc.y = Math.max(after, doc.y) + 4
    }
    rule()
    doc.moveDown(0.5)

    const sum = (label: string, value: string, bold = false) => {
      ensure(16)
      const y = doc.y
      doc.font(bold ? 'b' : 'r').fontSize(bold ? 10.5 : 9.5).fillColor(bold ? INK : DIM)
      doc.text(label, M + COLS.qty - 60, y, { width: COLS.amount - COLS.qty + 60 - 8, align: 'right' })
      doc.text(value, M + COLS.amount, y, { width: W - COLS.amount, align: 'right', ...num })
      doc.moveDown(0.25)
    }
    if (o.discount) {
      sum(t.subtotal, money(o.subtotal))
      sum(t.discount, money(-o.discount))
    }
    if (quote.vatCharged) sum(render(t.vat, { rate: String((quote.vatRateBp ?? 0) / 100) }), money(o.vat))
    sum(t.total, money(o.total), true)
    if (o.deposit) {
      sum(render(t.deposit, { percent: String((quote.depositBp ?? 0) / 100) }), money(o.deposit))
      sum(t.balance, money(o.total - o.deposit))
    }
    doc.moveDown(1.4)
  }
  for (const o of quote.options ?? []) option(o)

  ensure(70)
  doc.font('r').fontSize(9).fillColor(DIM)
  doc.text(t.terms, M, doc.y, { width: W })
  doc.moveDown(0.3)
  doc.text(t.notInvoice, M, doc.y, { width: W })
  doc.moveDown(0.3)
  doc.text(render(t.contact, { whatsapp: opts.whatsapp }), M, doc.y, { width: W })

  // Page numbers
  const range = doc.bufferedPageRange()
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i)
    doc.page.margins.bottom = 0     // writing in the margin must not start a new page
    doc.font('r').fontSize(8).fillColor(DIM)
      .text(render(t.page, { n: String(i + 1), total: String(range.count) }), M, doc.page.height - M - 10, { width: W, align: 'right', lineBreak: false })
  }
  doc.end()
  return done
}
