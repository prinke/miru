// AniList access tokens are bearer credentials with (per AniList's own docs)
// almost full access to the user's account, and they stay valid for a year.
// They are therefore encrypted before they reach the database, so a leaked
// backup or a stray read of the collection does not hand over anyone's account.

const crypto = require("node:crypto");

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = 1; // stored alongside the ciphertext so the scheme can change later

let cachedKey = null;

function readKey() {
  if (cachedKey) return cachedKey;

  const raw = (process.env.TOKEN_ENCRYPTION_KEY || "").trim();
  if (!raw) throw new Error("Missing TOKEN_ENCRYPTION_KEY in environment.");

  const key = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? "hex" : "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
      "Generate one with: openssl rand -hex 32"
    );
  }

  cachedKey = key;
  return key;
}

/** Lets callers refuse the feature up front rather than failing mid-flow. */
function isConfigured() {
  try {
    readKey();
    return true;
  } catch {
    return false;
  }
}

function seal(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, readKey(), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);

  return {
    v: VERSION,
    iv: iv.toString("base64"),
    // GCM's tag is what makes a tampered ciphertext fail to decrypt.
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64")
  };
}

function open(sealed) {
  if (!sealed || sealed.v !== VERSION) {
    throw new Error("Stored token is missing or uses an unknown encryption version.");
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    readKey(),
    Buffer.from(sealed.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(sealed.data, "base64")),
    decipher.final()
  ]).toString("utf8");
}

module.exports = { isConfigured, seal, open };
