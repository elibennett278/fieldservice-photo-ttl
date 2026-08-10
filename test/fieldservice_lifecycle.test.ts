import { decidePhotoExpiration } from "../src/fieldservice_lifecycle.ts";

const now = new Date("2026-08-10T12:00:00.000Z");
const closed = decidePhotoExpiration({ key: "wo-41/2026-07-01T12:00:00.000Z/closed", capturedAt: "2026-07-01T12:00:00.000Z", status: "closed" }, now, 30);
const followUp = decidePhotoExpiration({ key: "wo-42/2026-07-01T12:00:00.000Z/follow-up", capturedAt: "2026-07-01T12:00:00.000Z", status: "follow-up" }, now, 30);
if (closed.action !== "delete") throw new Error("closed expired work orders should be deleted");
if (followUp.action !== "keep") throw new Error("follow-up photos should remain available");
console.log("field-service lifecycle decision test passed");
