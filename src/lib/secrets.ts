import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SERVICE_NAME = "iris-agent";

/**
 * Stores secrets in the macOS login Keychain via the built-in `security`
 * CLI — the same store Keychain Access.app uses. No native npm dependency,
 * no compile step, nothing to go stale across Node/OS upgrades. macOS-only
 * by design (see the PRD's own note that a headless/non-macOS environment
 * needs a different, encrypted-file fallback — not implemented here since
 * Iris runs on an actual Mac).
 */
export async function setSecret(account: string, value: string): Promise<void> {
  // -U updates in place if an entry for this service+account already exists.
  await execFileAsync("security", [
    "add-generic-password",
    "-s",
    SERVICE_NAME,
    "-a",
    account,
    "-w",
    value,
    "-U",
  ]);
}

export async function getSecret(account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      SERVICE_NAME,
      "-a",
      account,
      "-w",
    ]);
    return stdout.trim();
  } catch (err) {
    // `security` exits non-zero when no matching entry exists — that's a
    // normal "not set up yet" state, not a failure worth surfacing.
    if (err && typeof err === "object" && "code" in err) {
      return null;
    }
    throw err;
  }
}

export async function deleteSecret(account: string): Promise<void> {
  try {
    await execFileAsync("security", ["delete-generic-password", "-s", SERVICE_NAME, "-a", account]);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      return;
    }
    throw err;
  }
}
