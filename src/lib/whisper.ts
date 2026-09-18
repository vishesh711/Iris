import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";

const WHISPER_BINARY = process.env.WHISPER_BINARY_PATH ?? "whisper-cli";
const WHISPER_MODEL = process.env.WHISPER_MODEL_PATH;
const FFMPEG_BINARY = process.env.FFMPEG_BINARY_PATH ?? "ffmpeg";

function run(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${binary} exited with code ${code}: ${stderr}`));
    });
  });
}

/**
 * Telegram voice notes are OGG/Opus; whisper.cpp expects WAV. Transcode to
 * 16kHz mono PCM WAV via ffmpeg before handing the file to whisper.
 */
async function transcodeToWav(audioPath: string): Promise<string> {
  const wavPath = `${audioPath}.wav`;
  await run(FFMPEG_BINARY, ["-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]);
  return wavPath;
}

/**
 * Shells out to a local whisper.cpp-compatible CLI. Expects the binary to
 * accept `-m <model> -f <audio> -otxt -of <outputPrefix>` and write
 * `<outputPrefix>.txt`, matching whisper.cpp's `main`/`whisper-cli` interface.
 */
export async function transcribeAudio(audioPath: string): Promise<string> {
  if (!WHISPER_MODEL) {
    throw new Error("WHISPER_MODEL_PATH is not set");
  }

  const wavPath = await transcodeToWav(audioPath);
  const outputPrefix = `${wavPath}.out`;

  try {
    await run(WHISPER_BINARY, ["-m", WHISPER_MODEL, "-f", wavPath, "-otxt", "-of", outputPrefix, "-nt"]);
    const text = await readFile(`${outputPrefix}.txt`, "utf8");
    return text.trim();
  } finally {
    await unlink(wavPath).catch(() => {});
    await unlink(`${outputPrefix}.txt`).catch(() => {});
  }
}
