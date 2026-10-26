# ZAMEENE integration patch — staged rollout

This patch adds authenticated Admin photo upload to existing `property_images` storage, approved-only photo serving, Admin bulk CSV import, BidKaro image mapping and 15-second refresh, and a **read-only** protected-access API using existing entitlement tables.

## Installation (do not overwrite without backups)

From `~/property-marketplace`:

```bash
mkdir -p backups
tar -czf backups/before-final-patch.tgz backend/src frontend/src apps/bidkaro/src
# Extract patch zip to the root AFTER making a separate full backup:
unzip -o ~/Downloads/zameene-integration-patch.zip -d ~/property-marketplace
(cd backend && npm run build)
(cd frontend && npx tsc --noEmit)
(cd apps/bidkaro && npm run typecheck)
```

**Important:** This patch does not implement Cashfree payment order creation, verified webhook handling, paid entitlement activation, automatic renewal, ZIP image matching, image edit/reorder, HTTPS or managed backups. **Do not enable live payments** or treat it as a production-ready release. Existing Supabase demo unlocks in BidKaro must be removed before commercial launch; this patch does not remove them. Existing local `backend/uploads` storage is NOT durable on many cloud hosts; move to object storage before production. The new `/api/access` endpoints depend on the existing `backend/sql/20261024_cashfree_payments.sql` migration, which must be reviewed/applied before starting backend. Do not apply blindly on a production DB.

## Quick verification

1. Verify admin login and creation with a test property and two photos; status should be PENDING.
2. Query `SELECT property_id, count(*) FROM property_images GROUP BY property_id;`.
3. Confirm pending listing is not in `/api/public/properties`.
4. Approve and verify cover image URL responds 200, refresh BidKaro.
5. Bulk CSV import a small test file; check records PENDING.
6. Check unauthorized `/api/access/properties/:id` returns 401; authorized but unpaid returns 403.
7. Restart backend and verify local uploaded photos still exist; on cloud hosting configure persistent storage.

## Known limitations

Photo upload occurs after property creation. If photo upload fails, property remains PENDING; UI reports the property ID for manual remediation. Photo limit for admin is 15; user uploads currently limited to 5. CSV import is atomic but does not deduplicate rows or import ZIP images. No real-time push: 15-second polling. Next.js multipart proxy may need increased request body limits at your hosting provider. No browser/build testing was performed against your machine or live database.
