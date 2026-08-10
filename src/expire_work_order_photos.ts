import { decidePhotoExpiration } from "./fieldservice_lifecycle.ts";
import type { WorkOrderPhoto } from "./fieldservice_lifecycle.ts";
import { infrai } from "./infrai.ts";

const BUCKET = "field-service-photos";
const TTL_DAYS = 30;

async function ensureBucket(): Promise<void> {
  await infrai.storage.bucket.create({ name: BUCKET });
}

function photoFromKey(key: string): WorkOrderPhoto {
  const [, capturedAt, status] = key.split("/");
  return { key, capturedAt, status: (status as WorkOrderPhoto["status"]) ?? "follow-up" };
}

export async function expirePhotos(now = new Date()): Promise<string[]> {
  await ensureBucket();
  const { items } = await infrai.storage.object.list(BUCKET);
  const deleted: string[] = [];
  for (const key of items) {
    const { found } = await infrai.storage.object.head(BUCKET, key);
    if (!found) continue;
    const decision = decidePhotoExpiration(photoFromKey(key), now, TTL_DAYS);
    if (decision.action === "delete") {
      await infrai.storage.object.delete(BUCKET, key);
      deleted.push(key);
    }
  }
  return deleted;
}

if (import.meta.main) {
  expirePhotos().then((deleted) => console.log(JSON.stringify({ bucket: BUCKET, deleted }))).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
