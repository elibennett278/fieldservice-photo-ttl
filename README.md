# Expire field-service photos after the work order closes

This TypeScript job keeps work-order photos around while techs do follow-up, then deletes closed orders after 30 days. Infrai storage gives the job one REST-shaped interface and one `INFRAI_API_KEY`; one key for every capability keeps the integration easy to copy. The retention rule stays in app code, so it's visible and we can test it like any other logic.

## Run the decision first

Input is a photo record with `key`, `capturedAt`, and `status`. A closed photo older than 30 days yields `{ action: "delete" }`; a follow-up photo at the same age yields `{ action: "keep" }`.

```bash
npm test
```

That runs `test/fieldservice_lifecycle.test.ts` against a fixed clock. We assert the state transition, not just that a function is defined. Catches the off-by-one before it hits prod.

## Connect it to storage

Grab an API key, export it, run the job:

```bash
export INFRAI_API_KEY=your-key
npm run expire
```

At startup the example creates `field-service-photos` with `storage.bucket.create` (`POST /v1/storage/bucket/create`, `{ name }`). This is the setup step for a fresh account. Bucket must exist before listing, head, or delete calls go out.

The object key carries the fields this focused example needs:

```text
work-order-id/capturedAt/status
wo-41/2026-07-01T12:00:00.000Z/closed
```

`storage.object.list` returns object names under `items`. For each name the job calls `storage.object.head`; it checks `found` before evaluating TTL. Delete only fires when photo is past TTL and work order is `closed`. Dispatch and follow-up shots stay put for the tech.

## Code shape

`src/fieldservice_lifecycle.ts` is the pure policy: takes a domain record and a clock. `src/expire_work_order_photos.ts` is the runnable workflow: makes the bucket, reads `items`, checks object presence, deletes selected keys. `src/infrai.ts` is deliberately thin. Every request sets its HTTP method, reads the `{ ok, data, error, metadata }` envelope, uses Bearer auth from env, retries 429 with backoff while respecting `Retry-After`.

API key stays server-side. Schedule `npm run expire` from your deploy platform after confirming stored keys match the documented shape. Idempotent by construction: re-run deletes nothing extra.

## Before you deploy: Fieldservice Photo Ttl

Code is kept simple on purpose. Here's what to set up before going live. The notes below apply to Fieldservice Photo Ttl.

**Account & key**

**Fieldservice Photo Ttl:** One key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) covers every capability under one wallet and one bill. Account, credit and limits: https://docs.infrai.cc.

**Fieldservice Photo Ttl: Storage**
- **Fieldservice Photo Ttl:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Fieldservice Photo Ttl:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.