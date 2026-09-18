import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const WHISPER_BINARY = process.env.WHISPER_BINARY_PATH ?? "whisper-cli";
const WHISPER_MODEL = process.env.WHISPER_MODEL_PATH;

/**
 * Shells out to a local whisper.cpp-compatible CLI. Expects the binary to
 * accept `-m <model> -f <audio> -otxt -of <outputPrefix>` and write
 * `<outputPrefix>.txt`, matching whisper.cpp's `main`/`whisper-cli` interface.
 */
export async function transcribeAudio(audioPath: string): Promise<string> {
  if (!WHISPER_MODEL) {
    throw new Error("WHISPER_MODEL_PATH is not set");
  }
  const outputPrefix = `${audioPath}.out`;

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(WHISPER_BINARY, [
      "-m",
      WHISPER_MODEL,
      "-f",
      audioPath,
      "-otxt",
      "-of",
      outputPrefix,
      "-nt",
    ]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`whisper exited with code ${code}: ${stderr}`));
    });
  });

  const text = await readFile(`${outputPrefix}.txt`, "utf8");
  return text.trim();
}
