import { ByokError } from "./errors.js";

/** The part of the Web Storage API the key store uses. */
export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface KeyStoreOptions {
  /**
   * Let visitors choose to keep their key in this browser across reloads.
   * Off by default: the key lives only in memory and is gone when the tab closes.
   */
  allowRemember?: boolean;
  /** Where a remembered key is kept. Defaults to `localStorage` when the page has one. */
  storage?: KeyStorage | null;
  /** The storage entry name. */
  storageKey?: string;
}

export const DEFAULT_STORAGE_KEY = "claude-byok:api-key";

/**
 * Check that a pasted string looks like an Anthropic API key, and refuse the
 * credentials a site must never accept. Returns the trimmed key.
 */
export function validateApiKey(input: string): string {
  const key = input.trim();
  if (key === "") {
    throw new ByokError("invalid_key", "Paste an Anthropic API key first.");
  }
  // Checked before the shape test so a pasted subscription token gets the right explanation.
  if (key.startsWith("sk-ant-oat")) {
    throw new ByokError(
      "subscription_token",
      "That looks like a Claude subscription sign-in token, not an API key. Websites aren't allowed to use Claude Free, Pro or Max sign-ins. Create an API key at platform.claude.com instead.",
    );
  }
  if (key.startsWith("sk-ant-admin")) {
    throw new ByokError(
      "admin_key",
      "That is an Admin API key, which can manage your whole Anthropic organisation. Never paste it into a website. Create an ordinary API key in its own workspace instead.",
    );
  }
  if (!key.startsWith("sk-ant-") || /\s/.test(key)) {
    throw new ByokError(
      "invalid_key",
      "That doesn't look like an Anthropic API key. Keys start with \"sk-ant-\" and come from platform.claude.com.",
    );
  }
  return key;
}

function defaultStorage(): KeyStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Some browsers throw on access when site data is blocked.
    return null;
  }
}

/**
 * Holds the visitor's key. In memory only unless the site allows remembering
 * and the visitor asks for it. Never serialises the key.
 */
export class KeyStore {
  #key: string | null = null;
  #remembered = false;
  readonly #allowRemember: boolean;
  readonly #storage: KeyStorage | null;
  readonly #storageKey: string;

  constructor(options: KeyStoreOptions = {}) {
    this.#allowRemember = options.allowRemember ?? false;
    this.#storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.#storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    // A site that turns remembering off also drops any key saved while it was on.
    if (this.#allowRemember) this.#loadRemembered();
    else this.#erase();
  }

  get allowRemember(): boolean {
    return this.#allowRemember;
  }

  /** Whether a key is held now. */
  hasKey(): boolean {
    return this.#key !== null;
  }

  /** Whether the held key is also saved in this browser. */
  isRemembered(): boolean {
    return this.#remembered;
  }

  /**
   * Store a key. `remember: true` also saves it in this browser, and needs the
   * site to have set `allowRemember`. Setting a key without `remember` deletes
   * any saved copy.
   */
  set(input: string, options: { remember?: boolean } = {}): void {
    const key = validateApiKey(input);
    const remember = options.remember ?? false;
    if (remember && !this.#allowRemember) {
      throw new ByokError("bad_config", "This site doesn't allow keys to be remembered.");
    }
    this.#key = key;
    if (remember) {
      this.#remembered = this.#write(key);
    } else {
      this.#erase();
      this.#remembered = false;
    }
  }

  /** The key, for the request code. Never shown or logged. */
  get(): string | null {
    return this.#key;
  }

  /** Forget the key: clear it from memory and from this browser's storage. */
  forget(): void {
    this.#key = null;
    this.#remembered = false;
    this.#erase();
  }

  toJSON(): { hasKey: boolean; remembered: boolean } {
    return { hasKey: this.hasKey(), remembered: this.#remembered };
  }

  toString(): string {
    return `KeyStore(${this.hasKey() ? "key set" : "no key"})`;
  }

  #loadRemembered(): void {
    let saved: string | null;
    try {
      saved = this.#storage?.getItem(this.#storageKey) ?? null;
    } catch {
      return;
    }
    if (saved === null) return;
    try {
      this.#key = validateApiKey(saved);
      this.#remembered = true;
    } catch {
      this.#erase();
    }
  }

  #write(key: string): boolean {
    try {
      if (!this.#storage) return false;
      this.#storage.setItem(this.#storageKey, key);
      return true;
    } catch {
      return false;
    }
  }

  #erase(): void {
    try {
      this.#storage?.removeItem(this.#storageKey);
    } catch {
      // Nothing more to do: the in-memory copy is already gone.
    }
  }
}
