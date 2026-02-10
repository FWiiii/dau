import { createHash } from "node:crypto";

export function makeMediaKey(tweetId: string, mediaUrl: string): string {
  return createHash("sha256").update(`${tweetId}::${mediaUrl}`).digest("hex");
}

