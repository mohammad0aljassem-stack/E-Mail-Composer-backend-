# ADR 0004 — Credential encryption

## Status: accepted (Phase 3A)

## Context

IMAP/SMTP credentials must be stored encrypted, decryptable only by the worker,
and impossible to replay against a different mailbox. The browser must never be
able to reach them.

## Decision

`CredentialCipher` (`src/crypto/credential-cipher.ts`) + an AES-256-GCM
implementation (`src/crypto/aes-gcm-cipher.ts`).

- **AEAD**: AES-256-GCM with a random 96-bit nonce per encryption and a 128-bit
  auth tag.
- **Versioned keyring**: `version → 32-byte key`. `key_version` is stored with
  each ciphertext; an **unknown version fails closed** (no key fallback).
- **Strict key-length validation**: every keyring key must be exactly 32 bytes.
- **AAD binding**: the AAD is `v1|ws=<workspace>|mb=<mailbox>|p=<purpose>`, so a
  ciphertext row cannot be decrypted against a different mailbox. A wrong AAD
  fails with a constant-shape `crypto_aad_mismatch` (and GCM auth would fail too).
- **Constant-shape errors**: decrypt failures surface only a code
  (`crypto_key_version_unknown` / `crypto_aad_mismatch` / `crypto_auth_failed`),
  never the reason or any bytes.
- **No secret logging, best-effort buffer zeroing** of plaintext after use.

Columns map 1:1 to `transport.mailbox_credentials`
(`ciphertext, nonce, auth_tag, algorithm, key_version, aad`). There is **no
plaintext column**. Only `transport_worker` + `service_role` can read the table;
`anon`/`authenticated` have nothing.

### Worker-only decryption

Decryption happens exclusively in `ImapSmtpProviderFactory`, constructed **only
when the feature flag is on**. With the flag off, no cipher and no factory exist,
so no credential is ever decrypted.

### Test-only provisioning

`src/entrypoints/provision-credential.ts` encrypts **synthetic** credentials from
stdin, writes only ciphertext, and **refuses production references**
(`fpanvpxjjddhasjmpflz`, `*.supabase.co`). No plaintext fixture is ever committed
(enforced by `test/unit/crypto.test.ts` and `scripts/secret-scan.sh`).

## Consequences

Key rotation is additive: add a new key version, set it active; old ciphertexts
still decrypt under their stored version until re-encrypted.
