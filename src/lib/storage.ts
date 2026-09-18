import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Telegram } from "telegraf";

const DATA_DIR = process.env.DATA_DIR ?? "./data/files";

export async function downloadTelegramFile(
  telegram: Telegram,
  fileId: string,
  suggestedExt: string
): Promise<{ path: string }> {
  await mkdir(DATA_DIR, { recursive: true });
  const fileLink = await telegram.getFileLink(fileId);
  const response = await fetch(fileLink.href);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Telegram file ${fileId}: ${response.status}`);
  }

  const destPath = path.join(DATA_DIR, `${fileId}${suggestedExt}`);
  await new Promise<void>((resolve, reject) => {
    const dest = createWriteStream(destPath);
    const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    nodeStream.pipe(dest);
    nodeStream.on("error", reject);
    dest.on("finish", () => resolve());
    dest.on("error", reject);
  });

  return { path: destPath };
}
