// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { ByokError } from "../src/errors.js";
import { DEFAULT_STORAGE_KEY, KeyStore, validateApiKey, type KeyStorage } from "../src/key.js";

// A made-up key in the right shape. No real key is used anywhere in these tests.
const KEY = "sk-ant-api03-TESTKEY-not-a-real-key-0000000000000000";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof ByokError) return error.code;
    throw error;
  }
  return undefined;
}

beforeEach(() => {
  localStorage.clear();
});

describe("validateApiKey", () => {
  it("accepts an API key and trims pasted whitespace", () => {
    expect(validateApiKey(`  ${KEY}\n`)).toBe(KEY);
  });

  it("refuses Claude subscription sign-in tokens", () => {
    expect(codeOf(() => validateApiKey("sk-ant-oat01-abcdef"))).toBe("subscription_token");
  });

  it("refuses Admin API keys", () => {
    expect(codeOf(() => validateApiKey("sk-ant-admin01-abcdef"))).toBe("admin_key");
  });

  it("refuses anything else", () => {
    for (const bad of ["", "   ", "sk-proj-abc", "hello", "sk-ant-api03 with spaces"]) {
      expect(codeOf(() => validateApiKey(bad)), bad).toBe("invalid_key");
    }
  });
});

describe("KeyStore", () => {
  it("keeps the key in memory only by default", () => {
    const store = new KeyStore();
    store.set(KEY);
    expect(store.get()).toBe(KEY);
    expect(store.isRemembered()).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it("won't remember a key unless the site allows it", () => {
    const store = new KeyStore();
    expect(codeOf(() => {
      store.set(KEY, { remember: true });
    })).toBe("bad_config");
    expect(store.hasKey()).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it("remembers the key in localStorage when the visitor opts in", () => {
    const store = new KeyStore({ allowRemember: true });
    store.set(KEY, { remember: true });
    expect(localStorage.getItem(DEFAULT_STORAGE_KEY)).toBe(KEY);
    expect(new KeyStore({ allowRemember: true }).get()).toBe(KEY);
  });

  it("clears memory and storage on forget", () => {
    const store = new KeyStore({ allowRemember: true });
    store.set(KEY, { remember: true });
    store.forget();
    expect(store.get()).toBeNull();
    expect(store.hasKey()).toBe(false);
    expect(store.isRemembered()).toBe(false);
    expect(localStorage.getItem(DEFAULT_STORAGE_KEY)).toBeNull();
    expect(new KeyStore({ allowRemember: true }).hasKey()).toBe(false);
  });

  it("deletes the saved copy when a key is set without remember", () => {
    const store = new KeyStore({ allowRemember: true });
    store.set(KEY, { remember: true });
    store.set(KEY);
    expect(store.hasKey()).toBe(true);
    expect(localStorage.getItem(DEFAULT_STORAGE_KEY)).toBeNull();
  });

  it("drops a saved key when the site has turned remembering off", () => {
    localStorage.setItem(DEFAULT_STORAGE_KEY, KEY);
    const store = new KeyStore();
    expect(store.hasKey()).toBe(false);
    expect(localStorage.getItem(DEFAULT_STORAGE_KEY)).toBeNull();
  });

  it("drops a saved value that isn't a valid key", () => {
    localStorage.setItem(DEFAULT_STORAGE_KEY, "sk-ant-oat01-saved-by-something-else");
    const store = new KeyStore({ allowRemember: true });
    expect(store.hasKey()).toBe(false);
    expect(localStorage.getItem(DEFAULT_STORAGE_KEY)).toBeNull();
  });

  it("keeps working in memory when storage throws", () => {
    const broken: KeyStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const store = new KeyStore({ allowRemember: true, storage: broken });
    store.set(KEY, { remember: true });
    expect(store.get()).toBe(KEY);
    expect(store.isRemembered()).toBe(false);
    store.forget();
    expect(store.hasKey()).toBe(false);
  });

  it("never serialises the key", () => {
    const store = new KeyStore({ allowRemember: true });
    store.set(KEY, { remember: true });
    expect(JSON.stringify({ store })).not.toContain(KEY);
    expect(String(store)).not.toContain(KEY);
    expect(Object.keys(store)).toEqual([]);
  });
});
