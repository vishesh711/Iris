import "dotenv/config";
import { createServer } from "node:http";
import { createOAuthClient, saveRefreshToken, GOOGLE_SCOPES } from "../lib/google/auth.js";

/**
 * One-time interactive OAuth consent flow, run manually (`npm run
 * google:auth-setup`). Uses the loopback IP flow (RFC 8252): a "Desktop
 * app" OAuth client accepts any http://127.0.0.1:<port> redirect without
 * pre-registering the exact port, so this binds to an OS-assigned free
 * port rather than a fixed one.
 */
async function main() {
  const client = createOAuthClient();

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind local OAuth callback server");
  }
  const redirectUri = `http://127.0.0.1:${address.port}`;

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    redirect_uri: redirectUri,
  });

  console.log("\nOpen this URL in your browser and approve access:\n");
  console.log(authUrl);
  console.log("\nWaiting for you to complete the consent flow...\n");

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      const authCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`Authorization failed: ${error}. You can close this tab.`);
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!authCode) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("No authorization code received. You can close this tab.");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Iris is now connected to Google. You can close this tab.");
      resolve(authCode);
    });
  });

  server.close();

  const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. If you've authorized this app before, revoke access at https://myaccount.google.com/permissions and try again."
    );
  }

  await saveRefreshToken(tokens.refresh_token);
  console.log("Refresh token saved to the macOS Keychain. Gmail/Calendar ingest can now authenticate.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
