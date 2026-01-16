/**
 * Cryptography utilities for secure data handling
 *
 * SECURITY: This module handles encryption of sensitive data like API keys.
 * Uses AES-256-GCM for authenticated encryption.
 */

import * as crypto from 'node:crypto';
import { logger } from './logger.js';

// =============================================================================
// Configuration
// =============================================================================

/** Encryption algorithm */
const ALGORITHM = 'aes-256-gcm';

/** Key length in bytes (256 bits) */
const KEY_LENGTH = 32;

/** IV length in bytes (96 bits recommended for GCM) */
const IV_LENGTH = 12;

/** Auth tag length in bytes */
const AUTH_TAG_LENGTH = 16;

/** Encryption key derivation salt (can be static for deterministic key derivation) */
const KEY_DERIVATION_SALT = process.env['ENCRYPTION_SALT'] || 'supervisor-agent-salt-v1';

/** Master password/key for encryption */
const MASTER_KEY = process.env['ENCRYPTION_KEY'] || process.env['JWT_SECRET'] || (
  process.env['NODE_ENV'] === 'production'
    ? (() => { throw new Error('ENCRYPTION_KEY must be set in production'); })()
    : 'dev-encryption-key-change-in-production'
);

// =============================================================================
// Key Management
// =============================================================================

/** Cached derived key */
let derivedKey: Buffer | null = null;

/**
 * Derive encryption key from master password
 * Uses PBKDF2 with SHA-256
 */
function getDerivedKey(): Buffer {
  if (derivedKey) {
    return derivedKey;
  }

  derivedKey = crypto.pbkdf2Sync(
    MASTER_KEY,
    KEY_DERIVATION_SALT,
    100000, // iterations
    KEY_LENGTH,
    'sha256'
  );

  return derivedKey;
}

/**
 * Clear the cached derived key (for testing or key rotation)
 */
export function clearKeyCache(): void {
  derivedKey = null;
}

// =============================================================================
// Encryption/Decryption
// =============================================================================

/**
 * Encrypt a string value
 *
 * Format: base64(iv + authTag + ciphertext)
 *
 * @param plaintext - The string to encrypt
 * @returns Encrypted string in base64 format, or null on error
 */
export function encrypt(plaintext: string): string | null {
  try {
    const key = getDerivedKey();
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    // Combine: iv + authTag + ciphertext
    const combined = Buffer.concat([iv, authTag, encrypted]);

    return combined.toString('base64');
  } catch (error) {
    logger.error('Encryption failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Decrypt an encrypted string
 *
 * @param ciphertext - The encrypted string in base64 format
 * @returns Decrypted string, or null on error
 */
export function decrypt(ciphertext: string): string | null {
  try {
    const key = getDerivedKey();
    const combined = Buffer.from(ciphertext, 'base64');

    // Extract components
    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      logger.error('Ciphertext too short');
      return null;
    }

    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (error) {
    logger.error('Decryption failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Check if a value is encrypted (heuristic based on format)
 */
export function isEncrypted(value: string): boolean {
  // Encrypted values are base64 and have minimum length
  if (value.length < (IV_LENGTH + AUTH_TAG_LENGTH + 1) * 4 / 3) {
    return false;
  }

  // Check if it's valid base64
  try {
    const decoded = Buffer.from(value, 'base64');
    // Re-encode and compare to check if it's actually base64
    if (decoded.toString('base64') !== value) {
      return false;
    }
    // Check minimum length after decoding
    return decoded.length >= IV_LENGTH + AUTH_TAG_LENGTH + 1;
  } catch {
    return false;
  }
}

/**
 * Encrypt a value if not already encrypted
 */
export function encryptIfNeeded(value: string): string {
  if (isEncrypted(value)) {
    return value;
  }
  return encrypt(value) || value;
}

/**
 * Decrypt a value if encrypted, otherwise return as-is
 */
export function decryptIfNeeded(value: string): string {
  if (!isEncrypted(value)) {
    return value;
  }
  return decrypt(value) || value;
}

// =============================================================================
// Hashing
// =============================================================================

/**
 * Hash a string using SHA-256
 */
export function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Hash a password using PBKDF2
 */
export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const passwordSalt = salt || crypto.randomBytes(16).toString('hex');
  const derivedHash = crypto.pbkdf2Sync(
    password,
    passwordSalt,
    100000,
    32,
    'sha256'
  ).toString('hex');

  return { hash: derivedHash, salt: passwordSalt };
}

/**
 * Verify a password against a hash
 */
export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const { hash: computedHash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(
    Buffer.from(hash, 'hex'),
    Buffer.from(computedHash, 'hex')
  );
}

// =============================================================================
// Secure Random
// =============================================================================

/**
 * Generate a secure random string
 */
export function generateSecureToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate a secure random string (URL-safe base64)
 */
export function generateSecureTokenUrlSafe(length: number = 32): string {
  return crypto.randomBytes(length)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
