# API Routes

This folder contains the domain-driven API modules for Viewora.

## 📁 Key Modules
- **`spaces.ts`**: Properties CRUD, publishing logic, and R2 signed URL generation.
- **`leads.ts`**: Prospect capture and CRM status management.
- **`analytics.ts`**: Aggregated performance metrics for virtual tours.
- **`billing.ts`**: Subscription lifecycle, plan listing, and Paystack integration.

## 🛠️ Routing Patterns
- **Namespacing**: Routes are grouped by entity.
- **Hooks**: Common logic (like owner verification) is implemented as Fastify prehandlers.
- **RPC Usage**: Frequently calls Supabase RPCs (e.g., `increment_active_properties`) for ACID-compliant usage tracking.

## 💡 Guidelines
- Always verify **Ownership** before allowing PATCH or DELETE operations on a resource.
- Ensure that the `leads` routes correctly handle the `status` field added in the production schema sync.
