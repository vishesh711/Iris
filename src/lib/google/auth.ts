import { google } from "googleapis";
import { getSecret, setSecret } from "../secrets.js";

export type OAuthClient = InstanceType<typeof google.auth.OAuth2>;

const TOKEN_ACCOUNT = "google-oauth-refresh-token";

// Read-only until Milestone 7, per the PRD's own reliability section.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export function createOAuthClient(): OAuthClient {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set");
  }
  return new google.auth.OAuth2(clientId, clientSecret);
}

export async function saveRefreshToken(refreshToken: string): Promise<void> {
  await setSecret(TOKEN_ACCOUNT, refreshToken);
}

export async function hasStoredRefreshToken(): Promise<boolean> {
  return (await getSecret(TOKEN_ACCOUNT)) !== null;
}

/**
 * Returns an OAuth client with the stored refresh token set. googleapis
 * handles refreshing the short-lived access token transparently on each
 * call — nothing else needs to know a refresh even happened.
 */
export async function getAuthorizedClient(): Promise<OAuthClient> {
  const refreshToken = await getSecret(TOKEN_ACCOUNT);
  if (!refreshToken) {
    throw new Error("No Google refresh token stored. Run `npm run google:auth-setup` first.");
  }
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
