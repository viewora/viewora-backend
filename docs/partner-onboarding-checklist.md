# Partner onboarding checklist (staff, Phase 0)

Phase 0 onboarding is staff-run. Work through this for each design partner,
then record the outcome in the admin. Agreements and data-processing terms
need Kenyan counsel; this list says where they fit, not what they say.

## 1. Before the call

- [ ] Application received: company name, registration certificate, KRA PIN, website, verticals, expected listing count, technical contact
- [ ] Company exists and the website and listings look genuine (no copied photos, prices that make sense)
- [ ] Property partners: Estate Agents Registration Board registration checked, if founders require it (open question D-verification)

## 2. Discovery call

- [ ] What system holds their listings (custom site, WordPress, a CRM, a dealer stock system)
- [ ] How many active listings, and how often prices and availability change
- [ ] Who will build the integration (in-house developer or an agency)
- [ ] Agree who owns which fields: their system owns listing facts; Viewora owns tours, pages and moderation (see `partner-listings-model.md`)
- [ ] Explain what v1 does not do: no writing back into their system, no sending to other portals
- [ ] Ask for an export of 50 or more real listings (CSV or JSON) for the sample check

## 3. Sample check

- [ ] Run `npm run partner:check-sample -- <export>` on their export
- [ ] Send them the list of missing fields and repeated IDs, in plain words
- [ ] Re-run until at least 90% of rows are valid
- [ ] Delete the export from your machine when done (it may hold personal data)

## 4. Paperwork

- [ ] Partner agreement signed (plan, number of agents, paid until)
- [ ] Data-processing terms signed (counsel's template)
- [ ] Incident contacts recorded: technical and business

## 5. Access

- [ ] Partner created in the admin; plan, paid-until and agent limit set
- [ ] Allowed embed sites set (production domains, plus `http://localhost:3000` while building)
- [ ] Test key issued and sent through a secure channel (never email the full key in plain text with the partner's name)
- [ ] Live key only after the integration checklist in the strategy doc is passed

## Phase 0 exit (all design partners together)

- [ ] 150 or more real listings checked with no missing required fields
- [ ] At least 2 partners committed to integrate in Phase 1
- [ ] Founders have confirmed decisions D1 to D8
- [ ] Counsel has reviewed controller and processor roles
