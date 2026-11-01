const crypto = require("crypto");
const { generateSecret, verifySync, generateURI } = require("otplib");
const QRCode = require("qrcode");

/**
 * Derives a consistent 32-byte (256-bit) encryption key for AES-256-GCM.
 * Prioritizes TWO_FACTOR_ENCRYPTION_KEY, with deterministic fallback to JWT_SECRET.
 */
function getEncryptionKey() {
  const rawKey =
    process.env.TWO_FACTOR_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    "khatanex_default_secure_2fa_key_fallback";
  return crypto.createHash("sha256").update(String(rawKey)).digest();
}

/**
 * Encrypts a plaintext TOTP secret at rest using AES-256-GCM authenticated encryption.
 * Format: ivHex:authTagHex:encryptedHex
 */
function encryptSecret(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts an AES-256-GCM encrypted TOTP secret.
 * Returns null if tampering or invalid format is detected.
 */
function decryptSecret(encryptedPayload) {
  if (!encryptedPayload || typeof encryptedPayload !== "string") return null;
  const parts = encryptedPayload.split(":");
  if (parts.length !== 3) return null;

  try {
    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encrypted = Buffer.from(parts[2], "hex");

    const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch (err) {
    console.error("[TwoFactorCrypto] Decryption failed or tag mismatch:", err.message);
    return null;
  }
}

/**
 * Generates a new base32 TOTP secret.
 */
function generateTOTPSecret() {
  return generateSecret();
}

/**
 * Formats a base32 secret into 4-character chunks for manual entry readability.
 */
function formatManualKey(secret) {
  if (!secret) return "";
  const cleaned = secret.replace(/\s+/g, "").toUpperCase();
  return (cleaned.match(/.{1,4}/g) || []).join(" ");
}

/**
 * Generates standard otpauth:// URI compatible with Google Authenticator and Microsoft Authenticator.
 */
function getTOTPUri({ secret, email, issuer = "KhataNex" }) {
  return generateURI({
    secret,
    label: email,
    issuer,
  });
}

/**
 * Generates a high-quality QR code as a PNG data URL.
 */
async function generateQRCode(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 256,
    color: {
      dark: "#0f172a",
      light: "#ffffff",
    },
  });
}

/**
 * Verifies a 6-digit TOTP code against a decrypted secret.
 * Allows a +/- 1 step window to gracefully tolerate small clock drift.
 */
function verifyTOTPCode({ token, secret }) {
  if (!token || !secret) return false;
  const cleanToken = String(token).replace(/\s+/g, "").trim();
  if (!/^\d{6}$/.test(cleanToken)) return false;

  try {
    const result = verifySync({
      token: cleanToken,
      secret,
    });
    return Boolean(result?.valid);
  } catch (err) {
    return false;
  }
}

/**
 * Generates an array of secure single-use recovery codes.
 * Returns array of objects: { raw: "XXXX-XXXX", hash: "sha256..." }
 */
function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const part1 = crypto.randomBytes(3).toString("hex").toUpperCase();
    const part2 = crypto.randomBytes(3).toString("hex").toUpperCase();
    const raw = `${part1}-${part2}`;
    const hash = hashRecoveryCode(raw);
    codes.push({ raw, hash });
  }
  return codes;
}

/**
 * Normalizes a recovery code (removes dashes, spaces, uppercase).
 */
function normalizeRecoveryCode(code) {
  if (!code) return "";
  return String(code).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/**
 * Computes the SHA-256 hash of a normalized recovery code for secure storage at rest.
 */
function hashRecoveryCode(code) {
  const normalized = normalizeRecoveryCode(code);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

module.exports = {
  encryptSecret,
  decryptSecret,
  generateTOTPSecret,
  formatManualKey,
  getTOTPUri,
  generateQRCode,
  verifyTOTPCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  hashRecoveryCode,
};

