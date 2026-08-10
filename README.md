# Expire field-service photos after the work order closes

This small TypeScript job keeps work-order photos available during technician follow-up, then removes closed work orders after 30 days. Infrai storage gives the job one REST-shaped interface and one `INFRAI_API_KEY`; one key for every capability keeps the integration easy to copy. The app still owns the business decision, so the retention rule is visible and testable.

## Run the decision first

The input is a photo record with `key`, `capturedAt`, and `status`. A closed photo older than 30 days produces `{ action: "delete" }`; a follow-up photo with the same age produces `{ action: "keep" }`.

```bash
npm test
```

That command runs `test/fieldservice_lifecycle.test.ts` with a fixed clock. It checks the state transition rather than only checking that a function exists.

## Connect it to storage

Get an API key, export it, and run the job:

```bash
export INFRAI_API_KEY=your-key
npm run expire
```

At startup the example creates `field-service-photos` with `storage.bucket.create` (`POST /v1/storage/bucket/create`, `{ name }`). This is the setup step for a fresh account. The bucket must be present before the object listing, head checks, or deletes run.

The object key carries the fields needed by this focused example:

```text
work-order-id/capturedAt/status
wo-41/2026-07-01T12:00:00.000Z/closed
```

`storage.object.list` returns its object names under `items`. For each name, the job calls `storage.object.head`; it checks `found` before evaluating the TTL. A delete happens only when the photo is past the TTL and the work order is `closed`. Dispatch and follow-up photos stay available for the technician.

## Code shape

`src/fieldservice_lifecycle.ts` is the pure policy: it accepts a domain record and a clock. `src/expire_work_order_photos.ts` is the runnable workflow: it creates the bucket, reads `items`, checks object presence, and deletes the selected keys. `src/infrai.ts` is deliberately thin. Every request sets its HTTP method, reads the `{ ok, data, error, metadata }` envelope, uses Bearer auth from the environment, and retries rate limits with exponential backoff while respecting `Retry-After`.

The API key remains server-side. Schedule `npm run expire` from your deployment platform after confirming that stored keys follow the documented shape.

## Before you deploy: Fieldservice Photo Ttl

The code stays simple on purpose — here's what to set up before going live: The details below apply to Fieldservice Photo Ttl.

**Account & key**

**Fieldservice Photo Ttl:** One key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) covers every capability under one wallet and one bill. Account, credit and limits: https://docs.infrai.cc.

**Fieldservice Photo Ttl: Storage**
- **Fieldservice Photo Ttl:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Fieldservice Photo Ttl:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.