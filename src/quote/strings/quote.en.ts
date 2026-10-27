// Words on the quote PDF. Placeholders: {{name}}. Add quote.sw.ts for Swahili.

export const quoteStringsEn = {
  brand: 'Viewora',
  title: 'Quotation',
  preparedFor: 'Prepared for {{name}} · {{industry}}',
  date: 'Date',
  validUntil: 'Valid until',
  reference: 'Reference',
  vatIncluded: 'Prices include VAT at {{rate}}%',
  vatExcluded: 'Prices exclude VAT',
  tiers: {
    essential: 'Essential',
    standard: 'Standard',
    premium: 'Premium',
    estimate: 'Estimate',
    draft: 'Quote'
  },
  recommended: 'Recommended',
  item: 'Item',
  qty: 'Qty',
  unit: 'Unit price',
  amount: 'Amount',
  subtotal: 'Subtotal',
  discount: 'Discount',
  vat: 'VAT ({{rate}}%)',
  total: 'Total',
  deposit: 'Deposit to book ({{percent}}%)',
  balance: 'Balance on delivery',
  noteHeading: 'A note from us',
  terms: 'Your shoot date is booked when the deposit is paid. The balance is due when your tour is delivered.',
  notInvoice: 'This is a quotation, not a tax invoice.',
  contact: 'Questions? WhatsApp us on {{whatsapp}}.',
  expired: 'This price expired on {{date}}. Ask us for an updated quote.',
  page: 'Page {{n}} of {{total}}'
}

export type QuoteStrings = typeof quoteStringsEn
