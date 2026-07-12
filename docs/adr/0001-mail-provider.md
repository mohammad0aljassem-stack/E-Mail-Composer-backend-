# ADR 0001 — Versioned, provider-agnostic MailProvider

## Status: accepted (Phase 3A)

## Context

We need to talk to IONOS over IMAP + SMTP now, but must not bake Gmail/Graph
assumptions into the core. Different providers differ on threads, IDLE, folder
mutation, and whether the client can dictate a stored Message-ID.

## Decision

`src/providers/mail-provider.ts` defines a **versioned** `MailProvider` with an
explicit `ProviderCapabilities` matrix (`contractVersion`, `supportsImapIdle`,
`supportsDraftAppend`, `supportsSentAppend`, `supportsMessageIdControl`,
`supportsFolderMutation`, `supportsNativeThreads`) and a `SyncCursor` type
(uidvalidity/uidnext/lastSeenUid/highestModseq). Higher layers **adapt to
capabilities** rather than assuming a backend.

The IMAP/SMTP implementation (`src/providers/imap-smtp/`) is built on two narrow
ports — `ImapClient` and `SmtpClient` — so protocol is swappable. Production
wires `ImapFlowClient` + `NodemailerSmtpClient`; tests wire in-repo fakes.

## Provider-specific behaviour (stays behind the interface)

- **No server-side threads** (`supportsNativeThreads=false`) — plain IMAP has no
  thread ids; we preserve `Message-ID`/`In-Reply-To`/`References` instead.
- **UID assignment is server-controlled**: IMAP `APPEND` assigns a _new_ UID the
  client cannot pre-choose. Draft replacement is therefore **append-then-retire**
  (append new, flag old `\Deleted`), never in-place update.
- **UID namespacing by UIDVALIDITY** — every UID is only meaningful within its
  folder's current `uidvalidity`.
- **Message-ID control is indirect**: the id is embedded in the MIME we APPEND /
  submit, not chosen by a server-side API.
- **IDLE** is a wake-up signal only → enqueue an incremental sync.

## Consequences

Adding Gmail/Graph later means a new provider implementation + capability flags,
with no change to the send/sync/mirror executors.
