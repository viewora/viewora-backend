# Utils (Business Logic)

This folder contains specialized logic that is not strictly "routing" but is essential for the Viewora platform.

## 🧪 Key Utilities
- **`quotas.ts`**: The "Financial Department" of the backend. It checks:
    - **Space Limits**: Can the user create more tours?
    - **Storage Limits**: Does the user have space for more images?
    - **Upload Limits**: Is this specific file too large (e.g., > 15MB)?

## 🛠️ Patterns
- **Context-Aware**: Utilities often take the `fastify` instance and `userId` to perform secure lookups in Supabase.
- **Defensive Defaults**: Use safe fallbacks (e.g., defaulting to 0 usage if a record is missing) to prevent blocking new users.

## 💡 Guidelines
- **NEVER** trust user-provided file sizes. Always calculate via the upload buffer or check the storage metadata.
- When adding new plan features, ensure the quota logic in `quotas.ts` is updated to handle the new entitlements.
