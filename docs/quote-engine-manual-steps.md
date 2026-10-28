# Quote engine: what you do by hand, in order

Nothing in Part A changes what visitors see: the old code ignores the new
settings, and the new tables are unused until the code is merged.
Stay in **Paystack test mode** and **sandbox messages** until Part D.

---

## Part A: you (about 45 minutes)

### A1. Back up the database
1. Open supabase.com → your Viewora project → **Database → Backups**.
2. If a backup from today is listed, note its time. If there is no backup (free plan), stop and tell Claude; it will give you a one-line command to download one.

### A2. See which migrations are already in
1. Supabase → **SQL Editor → New query**. Paste and **Run**:

```sql
select
  to_regclass('public.qe_staff') is not null                                  as m001,
  to_regclass('public.qe_rate_tables') is not null
    and exists (select 1 from pg_proc where proname = 'qe_admin_leads')       as m003,
  to_regclass('public.qe_quote_links') is not null                            as m004,
  to_regclass('public.qe_invoices') is not null                               as m005,
  to_regclass('public.qe_resume_tokens') is not null                          as m006,
  to_regclass('public.qe_partner_payouts') is not null                        as m007,
  exists (select 1 from pg_proc where proname = 'qe_report_rows')             as m008,
  exists (select 1 from pg_proc where proname = 'qe_lead_link_account')       as m009,
  to_regclass('public.qe_deliveries') is not null                             as m010;
```

2. Each column says `true` (already in) or `false` (still to run). If `m001` is `true`, also run `select count(*) from qe_rate_tables where status = 'published';`. If it says `0`, migration 002 still needs running.

### A3. Run the missing migrations, oldest first
On 28 Oct 2026 none were in yet, so expect to run all ten.
The files are in `D:\Viewora\viewora-backend\src\utils\`. For each number that was `false`, in order 001 → 010:
1. Open `migration-quote-engine-0NN.sql` in Notepad (002 is `migration-quote-engine-002-seed.sql`).
2. Select all, copy, paste into a **new** SQL Editor query, and **Run**.
3. You should see "Success. No rows returned". If you see an error, **stop**, copy the error and send it to Claude. Do not run the next file.

Never run the `.down.sql` files. They undo a migration.

After the last one, run the A2 query again. Every column should say `true`.

### A4. Make yourself quote staff
Put your own login email in and run:

```sql
insert into public.qe_staff (user_id, display_name, role, discount_limit_bp, alert_new_leads, alert_high_value)
select id, 'Peter', 'admin', 10000, true, true from auth.users where email = 'YOUR-LOGIN-EMAIL'
on conflict (user_id) do update set role = 'admin', active = true;
```

It should say "1 row". Do the same for anyone else on the team, using `'sales'` (discount limit `500` = 5%) or `'viewer'` (limit `0`). Each person must also be able to sign in to the admin today. If someone can't, set `is_admin = true` on their row in the `profiles` table.

### A5. Pick the studio account
This is the Viewora account you build client tours in.
1. Supabase → **Authentication → Users**. Find that account's email and copy its **User UID**.
2. Keep it for A7 (`QUOTE_STUDIO_USER_ID`).

### A6. Collect the keys
| What | Where |
| --- | --- |
| Paystack **test** secret key (`sk_test_…`) | dashboard.paystack.com → Settings → API Keys & Webhooks |
| PostHog personal API key | PostHog → your avatar → Personal API keys → Create. Scope: **Query: read** only |
| PostHog project ID | PostHog → Project settings (a number) |
| Gemini API key | aistudio.google.com → Get API key |
| Opt-out secret | In PowerShell: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |

### A7. Backend settings (Railway → viewora-backend → Variables)
Add these, then let it redeploy:

```
QUOTE_ENGINE_ENABLED=1
QUOTE_PUBLIC_URL=https://app.viewora.software
QUOTE_ADMIN_URL=<your admin address, e.g. https://admin.viewora.software>
QUOTE_OPTOUT_SECRET=<from A6>
QUOTE_PAYSTACK_SECRET_KEY=<sk_test_… from A6>
QUOTE_STUDIO_USER_ID=<from A5>
QUOTE_POSTHOG_PERSONAL_KEY=<from A6>
QUOTE_POSTHOG_PROJECT_ID=<from A6>
GEMINI_API_KEY=<from A6>
QUOTE_WHATSAPP=<your business WhatsApp, digits only, e.g. 2547XXXXXXXX>
```

Leave these **unset** for now: `QUOTE_PAYMENTS_LIVE`, `QUOTE_MESSAGES_SEND`, `QUOTE_ALERTS_SEND`, `QUOTE_PAYSTACK_USD`, `QUOTE_WHATSAPP_PROVIDER`.

### A8. App settings (Vercel → Viewora app → Settings → Environment Variables, Production)

```
NUXT_PUBLIC_QUOTE_ENGINE=1
NUXT_PUBLIC_QUOTE_WHATSAPP=<same number as QUOTE_WHATSAPP>
```

Leave `NUXT_PUBLIC_QUOTE_AB_CONTACT` unset for now.

### A9. Admin settings (wherever viewora-admin is hosted)

```
NUXT_PUBLIC_QUOTE_ENGINE=1
```

### A10. Paystack test webhook
Paystack → Settings → API Keys & Webhooks → **Test Webhook URL**:
`https://api.viewora.software/quote/payments/webhook`

### A11. Tell Claude "Part A done"
Include anything that did not go as described.

---

## Part B: Claude
1. Merges `feature/quote-engine` into `main` in `viewora-backend`, pushes, and waits for Railway to report a good deploy.
2. Then does the same for `Viewora` (Vercel) and `viewora-admin`.
3. Checks the live site answers: `/quote` loads, the admin Quotes tabs open, and a test lead saves.

From this point `/quote` is live on app.viewora.software, and logged-in users see "Order a capture" on Capture. Nothing links to `/quote` from the marketing site yet.

---

## Part C: you, on the live site, still in test mode (about 1 hour)
Follow `docs/quote-engine-staff-test.md` from start to finish. Use Paystack test cards and your own number. Then try one more path the local tests could not cover:
- Start a chat with the WhatsApp bot, open a delivery link from that chat, sign in, and tap **Add to my account**. The tour should move to your account.

Send Claude anything that did not match.

---

## Part D: going fully live (when you are ready)
1. **Lawyer:** get the consent wording reviewed under the Data Protection Act. It should mention that "Something else" descriptions may go to Google Gemini, with numbers and emails removed. Change it in the admin if needed.
2. **Retention:** decide how long to keep unfinished leads and tell Claude.
3. **Real money:**
   - In Railway, set `QUOTE_PAYSTACK_SECRET_KEY` to the `sk_live_…` key and add `QUOTE_PAYMENTS_LIVE=1`.
   - In Paystack, set the **Live Webhook URL** to the same address as A10.
   - Pay one small real deposit yourself and refund it.
4. **Real messages:** add `QUOTE_ALERTS_SEND=1` (staff emails) and `QUOTE_MESSAGES_SEND=1` (client emails and follow-ups). WhatsApp stays tap-to-send unless you later choose the WhatsApp Business Platform.
5. **USD in the form:** only once Paystack has enabled USD on your account, add `QUOTE_PAYSTACK_USD=1`.
6. **A/B test:** add `NUXT_PUBLIC_QUOTE_AB_CONTACT=1` on Vercel when you want half of visitors to give their number last.
7. **Link it:** ask Claude to add the "Get a price" links on the marketing site.
8. **Still to do by hand:** KRA eTIMS invoices are not connected yet. Issue them by hand for each payment.
