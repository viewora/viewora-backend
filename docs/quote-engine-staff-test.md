# Quote engine: manual test script for staff

Run this on staging (or production before launch) with **Paystack in test
mode** and **messages in sandbox** (`QUOTE_MESSAGES_SEND` and
`QUOTE_ALERTS_SEND` not set). Nothing here sends a real message or takes
real money.

Use a phone for the client steps (or a browser at 360 px wide) and a laptop
for the admin. Use your own WhatsApp number and a test email address, never
a real client's. Tick each box; if a result is different, write down what you
saw and the time.

You need: an admin login, a sales login, a client Viewora account, and one
finished tour in the studio account (`QUOTE_STUDIO_USER_ID`).

---

## 1. The public form (phone)

1. Open `/quote`.
   - [ ] "Step 1 of 5" shows. Industries are grouped; "Venue maps and wayfinding" and "Floor plans" are under "Maps and floor plans".
2. Tap **Homes and real estate**, then fill in your name and WhatsApp number. Leave consent unticked and tap Next.
   - [ ] You are asked to tick consent; nothing moves on until you do.
3. Tick consent and go on. Pick a 2-bedroom to let, add one extra, give a town and a timing.
   - [ ] The extras step shows a running total at the bottom that changes when you tap an extra.
   - [ ] The result shows three options with prices in KES, matching the rate table.
4. Start again and choose **US dollars** on the last step.
   - [ ] Prices show as USD. The pay note says payment is by link.
5. Start again, pick **Floor plans**, answer the questions.
   - [ ] The result says "We'll price this for you" and shows **no price**.
6. Start a form, stop after the contact step and close the tab.
   - [ ] In the admin **List**, the lead appears as not finished.

## 2. The lead desk (admin, sales login)

1. **List** and **Board**: find the lead from step 1.3.
   - [ ] Its answers, source and the consent wording with a timestamp are on the lead page.
2. Open the quote in the editor. Change a line and give a discount above your limit.
   - [ ] It goes to "needs approval"; an admin login can approve it.
3. Send the quote by link.
   - [ ] The WhatsApp text opens with the quote link; the quote page opens on your phone and has a PDF download.
4. Open a **Something else** lead's quote and tap **Suggest lines from their description**.
   - [ ] Suggestions show with rate-table prices. Nothing is saved until you add the lines and save.

## 3. Paying and the job (phone, then admin)

1. On the quote page, pick an option and pay the deposit with a Paystack **test** card or test M-Pesa.
   - [ ] You come back to the quote page and see the deposit as received.
   - [ ] In the admin **Jobs**, a job exists with the deposit paid.
2. Pick a shoot day on the quote page.
   - [ ] The job shows the requested day; confirm it in the admin.
3. On the job, add hours and a cost.
   - [ ] Profit and per-hour figures update.
4. Send the balance link. Pay it with a test card.
   - [ ] The job's balance shows paid. **Jobs → Download tracker (CSV)** works (admin only).

## 4. Delivering the tour

1. On the job, in **Deliver the tour**, pick the studio tour and tap **Make a delivery link**.
   - [ ] "Link ready" shows with "Open WhatsApp to send it" and "Copy the link".
   - [ ] In the main app, the tour is still in the studio account.
2. On the phone, signed out, open the link.
   - [ ] "Your tour is ready" asks you to sign in. Signing in brings you back to the link.
3. Tap **Add to my account**.
   - [ ] "Done. The tour is yours". The tour is under Spaces in the client account, with its scenes and media working.
4. Open the same link again from a different account.
   - [ ] "We can't open this link".
5. As **admin**, tap **Move back…**, give a reason and confirm.
   - [ ] The tour is back in the studio account; the job shows "Moved back to the studio".
   - [ ] A sales login does not see **Move back…**.

## 5. Ordering from an account (phone, client account)

1. In the app, open **Capture** and tap **Order a capture**.
   - [ ] The contact step is filled from your profile; you still tick consent.
2. Order a second time.
   - [ ] The contact step is skipped and says which number will be used. The whole order takes under 30 seconds.

## 6. Follow-ups and links

1. **Links**: make a message link for a named person and open it on the phone.
   - [ ] The form greets them by name with the industry picked.
2. Leave a form half done.
   - [ ] **To send** shows the reminder at the right time, never between 21:00 and 07:00 Nairobi time.
3. Reply from the lead's WhatsApp number (or mark the lead lost).
   - [ ] Their pending reminders stop.
4. Use the opt-out link at the bottom of a message.
   - [ ] The lead shows "Asked not to be contacted" and nothing more is queued.

## 7. Reports and settings

1. **Reports** for this week.
   - [ ] Your test forms appear in started, completed, quoted and booked, and in the drop-off by step.
   - [ ] Visitors shows a number, or "not connected" if the PostHog key is not set.
2. **Rate table**: change a price as admin and publish.
   - [ ] A new form shows the new price; old quotes keep theirs.
3. **Wording**: change the tour delivery message.
   - [ ] The next delivery link uses the new wording.
4. Sign in as a **viewer**.
   - [ ] You can read leads, jobs and reports, but every edit button is missing or refused.

## When you finish

Delete or mark lost the test leads, move test tours back, and write down
anything that did not match.
