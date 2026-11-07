// Secrets used by the API: session ids, API keys and share tokens.
// Only SHA-256 hashes of keys and tokens are stored, so a copy of the
// database cannot be used to call the API.
import { createHash, randomBytes } from 'node:crypto';

/** Public id of a tracking session. It appears in share links, so it is not a secret. */
export function newSessionId() {
  return `ses_${randomBytes(9).toString('base64url')}`;
}

/** API key for other apps and for the tracker. Shown in full when generated. */
export function newApiKey() {
  return `lt_${randomBytes(24).toString('base64url')}`;
}

/** Read-only token used in share links. Resetting the link replaces it. */
export function newShareToken() {
  return `lts_${randomBytes(18).toString('base64url')}`;
}

/** SHA-256 hex digest of a secret. The database stores and looks up this value. */
export function hashSecret(secret) {
  return createHash('sha256').update(secret).digest('hex');
}
