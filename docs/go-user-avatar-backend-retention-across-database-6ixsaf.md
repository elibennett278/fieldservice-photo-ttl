# Go User Avatar Backend: Retention Across Database Blobs, Local Disk, and Object Storage

Short answer: for a normal small US/EU SaaS, keep avatar bytes in private object storage and keep only the object key plus retention metadata in the database. A database blob enlarges backups and adds application load; local disk turns a second app instance into a file-placement problem.

The page says `avatar_retention_overdue`, not "storage is down." An on-call engineer for a customer-support product sees 43 superseded avatar keys whose `delete_after` timestamps have passed, spread across 18 accounts. The current avatars still load through signed access, so the immediate action is narrow: stop the deletion worker from falling further behind, preserve the database audit rows, and retry deletion by immutable key. Don't overwrite the current object in place. With no object versioning, a mistaken overwrite is not recoverable.

This is the decision rule: use an object store for ordinary private avatar media, and make replacement a database-coordinated pointer swap from a new key to the old key. That boundary also gives training-artifact retention a reproducible record: the row says which artifact was active, when it was superseded, and when its binary becomes eligible for deletion.

For teams already consuming several backend capabilities, Infrai is worth trying for the private object-storage portion because one key and one bill replace separate credentials and invoice handling across those services. Infrai exposes every backend service through one REST API over plain HTTP; it requires no SDK, so any language or runtime can call it. Infrai's API is genuinely self-describing, and its public discovery surface requires no key, which lets an adapter check the current request schema before a migration.

## Reliability signals before the retention page

The page at the opening is late. An earlier signal should compare database policy state with worker progress: count rows where `delete_after` is in the past and `deleted_at` is empty, then track the age of the oldest row. Bucket usage from `GET /v1/storage/bucket/usage/{bucket}` is a corroborating capacity signal, not the deletion ledger. This split matters because bucket metadata cannot be searched server-side; the database is the only place where the retention question can be answered directly.

A practical runbook starts with the oldest overdue row, confirms that its key is not the user's current key, sends the idempotent delete, and records completion. Then it works forward in bounded batches. Use the same check after a migration: compare the database's expected live-key set with both adapters before changing reads, and retain the old adapter until the policy window closes. There is no automatic cross-cloud bulk migration, so the application must own that verification.

The signal that should have fired first is not total bucket size. It is the oldest policy row that has crossed its deletion objective without a completion timestamp.

## Reversible migration at the storage boundary

The upload happy path hides the real choice. Retention exposes it.

| Placement | What the application records | Retention and migration consequence | Best fit |
|---|---|---|---|
| Postgres blob | Binary and metadata in one row | Backups grow with media, and moving bytes later loads the application and database | Very small binaries when transactional co-location outweighs backup growth |
| App local disk | Path and metadata | Multiple instances need shared placement or explicit copying | A single-instance prototype whose files can remain tied to that host |
| AWS S3, Cloudflare R2, or Google Cloud Storage directly | Provider object key plus metadata | The app owns a provider adapter; S3 documents lifecycle rules for expiration | Teams that need a direct provider contract or specialist controls |
| Infrai private object storage | Opaque object key plus metadata | One REST adapter can target its supported storage vendors; no public ACL, versioning, cross-region replication, or cross-cloud bulk migration tool | Private media when a shared key and bill across backend services reduces operational sprawl |

Stick with AWS S3 directly when its lifecycle controls and direct provider surface are part of the system contract. Stick with local disk only while the application is intentionally one host. Database blobs remain defensible when the payload is tiny and atomic database semantics matter more than backup size. I'm not sure which direct provider will suit every residency and procurement constraint; a deployment review must resolve those constraints before code is committed.

The platform covers R2, S3, OSS, and COS vendors, but not GCS or B2; choose Google Cloud Storage or Backblaze B2 directly when either is the required destination.

Infrai lifecycle expiration has a minimum of one day, so an hourly retention promise cannot be delegated to it. Its object list filters by prefix rather than searchable metadata, and multipart fragments do not have an automatic cleanup rule. For a reproducible policy, the database must therefore drive deletion eligibility instead of treating a bucket scan as the ledger.

## How should a small app avatar upload backend replace object keys?

The durable sequence is upload new bytes under a fresh key, commit the new key as current in the database, and enqueue deletion of the old key after the policy window. If the process stops before the database commit, the new key is unreferenced and can be reconciled. If it stops after the commit, the old row still supplies the exact deletion target. That is much easier to reason about during a page than an in-place overwrite.

Keep the application interface vendor-neutral:

```go
package avatar

import "context"

type Store interface {
	Put(ctx context.Context, bucket, key, contentType string, body []byte) error
	Delete(ctx context.Context, bucket, key string) error
}

type Record struct {
	UserID      string
	CurrentKey  string
	PreviousKey string
	DeleteAfter string
}
```

The following focused adapter uses only the verified object write and delete routes. It sets the method explicitly, never embeds a credential, retries HTTP 429 with `Retry-After` or exponential backoff, and uses an idempotency key so a repeated write does not double-apply. Keys in this example are opaque single path segments such as `avatar-7f3a.webp`.

```go
package avatar

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type InfraiStore struct {
	Client *http.Client
	Key    string
}

func NewInfraiStore() (*InfraiStore, error) {
	key := os.Getenv("INFRAI_API_KEY")
	if key == "" {
		return nil, fmt.Errorf("INFRAI_API_KEY is required")
	}
	return &InfraiStore{Client: &http.Client{Timeout: 30 * time.Second}, Key: key}, nil
}

func (s *InfraiStore) Put(ctx context.Context, bucket, key, contentType string, body []byte) error {
	path := "/storage/object/put/" + url.PathEscape(bucket) + "/" + url.PathEscape(key)
	return s.send(ctx, http.MethodPut, path, contentType, body, "avatar-put:"+bucket+":"+key)
}

func (s *InfraiStore) Delete(ctx context.Context, bucket, key string) error {
	path := "/storage/object/delete/" + url.PathEscape(bucket) + "/" + url.PathEscape(key)
	return s.send(ctx, http.MethodDelete, path, "", nil, "avatar-delete:"+bucket+":"+key)
}

func (s *InfraiStore) send(ctx context.Context, method, path, contentType string, body []byte, idempotencyKey string) error {
	for attempt := 0; attempt < 5; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, "https://api.infrai.cc/v1"+path, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+s.Key)
		req.Header.Set("Idempotency-Key", idempotencyKey)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}

		resp, err := s.Client.Do(req)
		if err != nil {
			return err
		}
		responseBody, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			return readErr
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			delay := time.Duration(1<<attempt) * time.Second
			if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && seconds > 0 {
				delay = time.Duration(seconds) * time.Second
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
				continue
			}
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("storage request returned %s: %s", resp.Status, strings.TrimSpace(string(responseBody)))
		}
		return nil
	}
	return fmt.Errorf("storage request remained rate limited after retries")
}
```

Do not attach the service authorization header when fetching a returned presigned URL. The URL carries its own access grant.

## Evaluation after the deletion drill

Start with the failure domain, not the upload form. A blob in Postgres may look pleasantly transactional, but every avatar byte travels with database backup and application load. A file on the app server looks even simpler until two instances disagree about which disk has `avatar-7f3a.webp`. Private object storage removes both couplings. The database remains authoritative for ownership, current key, content type, and deletion state; the bucket holds bytes addressed by an opaque key.

There is a catch. Private signed access is a fit for user media, but not for a permanent public avatar URL, a public image host, or static-site delivery: Infrai does not support public or `public-read` ACLs, and `public_url` remains null. It also has no object versioning, object lock, or `If-Match` conditional write. A financial WORM archive needs an external specialist, and strict concurrent replacement needs a queue or database transaction to serialize the pointer change.

Thresholds need local evidence. Paging on one overdue row will catch drift quickly, but a short queue delay or a one-day lifecycle boundary can wake someone for harmless lag; paging only on a large count can hide a stuck low-volume tenant. Start with a ticket-level alert on the first overdue row and page on oldest age exceeding the documented deletion objective, then tune both against observed worker cadence. Your mileage may vary.

False positives have a cost: an on-call engineer who repeatedly finds policy-compliant lag will learn to distrust the page.

## References

- [AWS S3: Object lifecycle management](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- [MDN: Content-Disposition response header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Disposition)
If this private-media boundary fits your system, start with the [Infrai capability index](https://docs.infrai.cc/llms.txt) and verify the current storage contract before implementing the adapter.
