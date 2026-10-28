import { SessionBudget } from "../../src/budget.js";

/** An app registered with Anthropic, as it would be in the Console. */
export interface RegisteredClient {
  id: string;
  name: string;
  /** Exact redirect URIs. Their origins are the only ones allowed to call the API with this app's tokens. */
  redirectUris: readonly string[];
  /** The models the app asks for. The visitor can allow fewer. */
  models: readonly string[];
  /** The monthly limit pre-filled on the consent page. The visitor chooses the real one. */
  suggestedLimitUsd: number;
}

/** An authorization request waiting on the consent page. */
export interface PendingAuthorization {
  id: string;
  client: RegisteredClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  expiresAt: number;
}

/** A one-time code handed to the app after consent. */
export interface AuthorizationCode {
  code: string;
  client: RegisteredClient;
  redirectUri: string;
  codeChallenge: string;
  limitUsd: number;
  models: string[];
  expiresAt: number;
}

/** What the visitor allowed one app to do. */
export interface Grant {
  id: string;
  client: RegisteredClient;
  limitUsd: number;
  models: string[];
  /** The calendar month (UTC, "YYYY-MM") the budget counts. */
  month: string;
  budget: SessionBudget;
  createdAt: number;
  revoked: boolean;
}

export interface IssuedToken {
  value: string;
  kind: "access" | "refresh";
  grantId: string;
  expiresAt: number;
  used: boolean;
}

export function monthOf(time: number): string {
  return new Date(time).toISOString().slice(0, 7);
}

/** Everything the stand-in remembers. In memory only: a restart forgets it all. */
export class Store {
  readonly clients = new Map<string, RegisteredClient>();
  readonly pending = new Map<string, PendingAuthorization>();
  readonly codes = new Map<string, AuthorizationCode>();
  readonly grants = new Map<string, Grant>();
  readonly tokens = new Map<string, IssuedToken>();

  constructor(clients: readonly RegisteredClient[]) {
    for (const client of clients) this.clients.set(client.id, client);
  }

  /** The grant's budget for the current month, starting a fresh one when the month turns. */
  budgetFor(grant: Grant, now: number): SessionBudget {
    const month = monthOf(now);
    if (grant.month !== month) {
      grant.month = month;
      grant.budget = new SessionBudget(grant.limitUsd);
    }
    return grant.budget;
  }

  revokeGrant(grantId: string): void {
    const grant = this.grants.get(grantId);
    if (grant) grant.revoked = true;
    for (const [value, token] of this.tokens) {
      if (token.grantId === grantId) this.tokens.delete(value);
    }
  }
}
