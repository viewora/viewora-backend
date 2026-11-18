# Viewora Partner API (v1)

For property and car apps that want 360° tours on their listings. You create an
account for each of your agents or dealers, create tours for them, upload their
photos, publish, and embed the tour on your listing page.

Base URL: `https://api.viewora.software/v1`

## Keys

Viewora staff give you two keys:

- `vo_test_…` for building. Test agents and tours are kept apart from live ones.
- `vo_live_…` for real listings.

Send the key on every request:

```
Authorization: Bearer vo_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Keep keys on your server. Never put them in a browser or a mobile app.

## 1. Create an agent

Each agent or dealer gets their own Viewora account. They can later sign in at
app.viewora.software with this email (using "Forgot password") to edit their
tours themselves. Creating the account sends no email.

```bash
curl -X POST $BASE/agents -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"external_id":"dealer-7","name":"Wanjiku Motors","email":"sales@wanjikumotors.co.ke"}'
```

- `external_id` is your own id for the agent.
- Calling this again with the same `external_id` returns the existing agent (`"created": false`).
- If the email already has a Viewora account you get `409 EMAIL_IN_USE`. We never
  link an existing account without its owner's consent.
- With a test key, `email` is optional and is not used.
- Your agreement with Viewora covers a number of live agents. Past that you get
  `403 AGENT_LIMIT_REACHED`. Test agents don't count.
- Every agent you create is on the plan your agreement pays for.

## 2. Create a tour

```bash
curl -X POST $BASE/tours -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"agent_external_id":"dealer-7","external_id":"CAR-123","title":"Toyota Prado 2019",
       "type":"automotive","details":{"vehicle_year":2019,"price_kes":6500000}}'
```

- `type`: `residential`, `commercial`, `hospitality`, `education`, `automotive`, `land` or `other`.
- `external_id` is your listing id. It must be unique; a repeat returns
  `409 TOUR_EXISTS` with the existing tour in `error.tour`.
- `details` (optional): `price_kes`, `listing_status`, `transaction_type`, `price_period`,
  `bedrooms`, `bathrooms`, `area_sqm`, `vehicle_year`, `vehicle_mileage_km`,
  `vehicle_transmission`, `vehicle_fuel_type`, `land_acres`, `land_type`, `amenities`.
- Tours count against the plan your agreement pays for (tours per agent, scenes per tour).

## 3. Upload photos

Two calls per file, with the file going straight to storage in between.

```bash
# a) start: get a signed URL (valid 15 minutes)
curl -X POST $BASE/tours/$TOUR_ID/uploads -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"kind":"panorama","file_name":"lounge.jpg","content_type":"image/jpeg","file_size":8123456}'
# → { "upload_key": "...", "upload_url": "https://...", "method": "PUT", "headers": {"Content-Type":"image/jpeg"} }

# b) send the file
curl -X PUT "$UPLOAD_URL" -H "Content-Type: image/jpeg" --data-binary @lounge.jpg

# c) finish
curl -X POST $BASE/tours/$TOUR_ID/uploads/complete -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"kind":"panorama","upload_key":"...","name":"Lounge"}'
```

| `kind` | Use for | Notes |
|---|---|---|
| `panorama` | A full 360° photo (2:1 equirectangular JPEG) | Becomes a 360 scene. `name` is the scene name. |
| `photo` | An ordinary listing photo | Goes to the photo gallery. |
| `car_exterior` | One photo of a car from outside | `angle` (0–359, 0 = front) is required. Photos form the car's spin. |

Calling `complete` twice for the same file is safe. Processing takes a short
while after `complete` returns.

## 4. Publish and embed

```bash
curl -X POST $BASE/tours/$TOUR_ID/publish -H "Authorization: Bearer $KEY"
```

The tour now has `embed_url` and `share_url`:

```html
<iframe src="EMBED_URL" width="100%" height="480" style="border:0"
        allow="fullscreen; xr-spatial-tracking" allowfullscreen loading="lazy"></iframe>
<script src="https://app.viewora.software/embed.js" defer></script>
```

`embed.js` is optional. It lets the tour go full screen on iPhone.

Tell Viewora which sites will show your tours (for example
`https://cars.example.co.ke`). Your tours then only load inside those sites.
Add `http://localhost:3000` while you build.

`POST /tours/:id/unpublish` takes it down. `DELETE /tours/:id` deletes it.

## Reading tours

- `GET /tours/:id`
- `GET /tours?external_id=CAR-123`: find a tour by your listing id
- `GET /tours?agent_external_id=dealer-7&limit=50&offset=0`
- `GET /agents`, `GET /agents/:external_id`

A tour looks like this:

```json
{ "id": "…", "external_id": "CAR-123", "agent_external_id": "dealer-7", "mode": "live",
  "title": "Toyota Prado 2019", "type": "automotive", "status": "published",
  "has_360": true, "has_photos": true, "cover_image_url": "…",
  "embed_url": "https://app.viewora.software/embed/…", "share_url": "https://app.viewora.software/p/…",
  "created_at": "…", "updated_at": "…" }
```

## Errors

```json
{ "error": { "code": "TOUR_NOT_FOUND", "message": "No tour with this id for your account." } }
```

Validation errors add `fields: [{ field, message }]`. Common codes:
`UNAUTHORIZED`, `PARTNER_SUSPENDED`, `VALIDATION_ERROR`, `AGENT_NOT_FOUND`,
`TOUR_NOT_FOUND`, `TOUR_EXISTS`, `EMAIL_IN_USE`, `INVALID_UPLOAD_KEY`,
`AGENT_LIMIT_REACHED`, `TOUR_LIMIT_REACHED`, `SCENE_LIMIT_REACHED`, `FILE_TOO_LARGE`, `DAILY_UPLOAD_CAP`,
`RATE_LIMITED`.

## Limits

- Requests per key per minute: 300 for reads, 120 for tour changes, 600 for uploads, 60 for agent creation.
- Uploads per day per partner: set by Viewora (default 2,000). The count resets at midnight EAT.
- Plan limits (tours, scenes, file size, storage) come from the plan your agreement pays for, per agent.

## Not yet available

Webhooks (tour ready or failed), uploading from a URL, and white-label branding
are planned for the next phases.
