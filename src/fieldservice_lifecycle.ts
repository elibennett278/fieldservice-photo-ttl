export type WorkOrderPhoto = {
  key: string;
  capturedAt: string;
  status: "dispatched" | "follow-up" | "closed";
};

export type ExpirationDecision = { key: string; action: "delete" | "keep"; reason: string };

export function decidePhotoExpiration(photo: WorkOrderPhoto, now: Date, ttlDays: number): ExpirationDecision {
  const ageMs = now.getTime() - new Date(photo.capturedAt).getTime();
  const expired = ageMs >= ttlDays * 24 * 60 * 60 * 1000;
  if (expired && photo.status === "closed") {
    return { key: photo.key, action: "delete", reason: "closed work order is past the photo TTL" };
  }
  return { key: photo.key, action: "keep", reason: expired ? "follow-up still needs the photo" : "photo is within its TTL" };
}
