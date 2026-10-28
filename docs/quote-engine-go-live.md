# Quote engine: go-live checklist

The quote engine is on `feature/quote-engine` in `viewora-backend`,
`Viewora` and `viewora-admin`. It stays off until the switches below are
set, so the branches can be merged before launch.

## 1. Database (Supabase)

Migrations live in `src/utils/`. Each has a `.down.sql` rollback.
Apply 001 to 010 in order, after a backup (001 creates the quote tables,
002 publishes the rate table and consent text, 003 to 005 the desk, links
and payments; the check query in `quote-engine-manual-steps.md` A2 shows
which are in). From 006:

| File | What it does | Touches outside `qe_*`? |
| --- | --- | --- |
| `migration-quote-engine-006.sql` | Follow-up sequences and their wording | No |
| `migration-quote-engine-007.sql` | `/q/:code` links, partners, payouts | No |
| `migration-quote-engine-008.sql` | Report rows (`qe_report_rows`) | No (reads only) |
| `migration-quote-engine-009.sql` | Which account started a request | No |
| `migration-quote-engine-010.sql` | Tour delivery | **Yes**: changes `properties.user_id` when a client accepts a link, and recounts `usage_counters` |

Rolling back 010 does not move delivered tours back. Use **Move back…** on
the job page first.

## 2. Backend environment (Railway)

| Variable | Needed for | Notes |
| --- | --- | --- |
| `QUOTE_ENGINE_ENABLED=1` | Everything | Registers the quote routes |
| `QUOTE_PUBLIC_URL` | Links in messages | e.g. `https://app.viewora.software` |
| `QUOTE_ADMIN_URL` | Links in staff alerts | The admin's address |
| `QUOTE_OPTOUT_SECRET` | Opt-out links | A long random string; falls back to `ADMIN_SECRET` |
| `QUOTE_PAYSTACK_SECRET_KEY` | Deposits and balances | Start with the `sk_test_` key |
| `QUOTE_PAYMENTS_LIVE=1` | Real money | Only with the live key, after the staff test passes |
| `QUOTE_PAYSTACK_USD=1` | Paying in USD in the form | Only once Paystack enables USD on the account |
| `QUOTE_STUDIO_USER_ID` | Tour delivery | The account staff build tours in |
| `QUOTE_ALERTS_SEND=1`, `QUOTE_ALERT_EMAILS` | Staff alert emails | Off means alerts are logged, not sent |
| `QUOTE_MESSAGES_SEND=1` | Client emails and follow-ups | Off means sandbox |
| `QUOTE_WHATSAPP_PROVIDER=cloud` | Sending WhatsApp from the server | Leave unset for tap-to-send. Check Meta's current Business Platform rules first |
| `QUOTE_POSTHOG_PERSONAL_KEY`, `QUOTE_POSTHOG_PROJECT_ID` | Visitor numbers in Reports | A read-only personal key; Reports says "not connected" without it |
| `GEMINI_API_KEY` | AI suggestions for "Something else" | Without it the button says AI is off |

## 3. App and admin environment

| Variable | Where | Notes |
| --- | --- | --- |
| `NUXT_PUBLIC_QUOTE_ENGINE=1` | App and admin | Shows the form, quote pages, Capture card and admin tabs |
| `NUXT_PUBLIC_QUOTE_WHATSAPP` | App | The number "Talk to us" opens |
| `NUXT_PUBLIC_QUOTE_AB_CONTACT=1` | App | Starts the contact-first test (half of visitors give their number last) |

## 4. Before switching on real money and messages

- [ ] Run `docs/quote-engine-staff-test.md` end to end with Paystack test mode and sandbox messages.
- [ ] Set the Paystack webhook to `https://api.viewora.software/quote/payments/webhook`.
- [ ] Have a lawyer review the consent wording under Kenya's Data Protection Act. The wording should also say that "Something else" descriptions may be sent to Google's Gemini for a draft (phone numbers and emails removed).
- [ ] Confirm the abandoned-lead retention period.
- [ ] KRA eTIMS: `src/quote/invoicing.ts` is the hook. Until it is connected, staff issue invoices by hand.
- [ ] Prices in the rate table are the ones you mean to publish. Venue maps and floor plans stay "we'll confirm" until they have a base price.
