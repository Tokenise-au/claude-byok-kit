import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 7636: a verifier is 43 to 128 characters from the unreserved set. */
export function isValidVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

/** An S256 challenge is the base64url SHA-256 of the verifier: always 43 characters. */
export function isValidChallenge(challenge: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(challenge);
}

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifierMatches(verifier: string, challenge: string): boolean {
  if (!isValidVerifier(verifier)) return false;
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(s256(verifier));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** An unguessable identifier with a readable prefix. */
export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}
