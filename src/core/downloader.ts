import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { logger } from "../logger.js";
import type { LocalMediaFile, MediaType } from "../types.js";
import { ensureParentDir, fileSize } from "../utils/fs.js";

interface DownloadMediaInput {
  mediaKey: string;
  mediaUrl: string;
  mediaType: MediaType;
  downloadDir: string;
}

function extensionByType(type: MediaType): string {
  if (type === "photo") {
    return ".jpg";
  }

  return ".mp4";
}

export async function downloadMedia(
  input: DownloadMediaInput,
): Promise<LocalMediaFile> {
  const extension = extensionByType(input.mediaType);
  const outputPath = path.join(input.downloadDir, `${input.mediaKey}${extension}`);

  await ensureParentDir(outputPath);

  const response = await fetch(input.mediaUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download media (${response.status})`);
  }

  await pipeline(response.body, createWriteStream(outputPath));
  const size = await fileSize(outputPath);

  logger.debug(
    {
      mediaKey: input.mediaKey,
      outputPath,
      size,
    },
    "Downloaded media file",
  );

  return {
    mediaKey: input.mediaKey,
    mediaUrl: input.mediaUrl,
    mediaType: input.mediaType,
    path: outputPath,
    fileSizeBytes: size,
  };
}

