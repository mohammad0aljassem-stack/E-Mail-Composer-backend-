# Third-party notices

This project uses the following direct third-party packages, each under its own
license. Transitive dependencies carry their own licenses (see `pnpm-lock.yaml`
and the automated `scripts/license-check.mjs` gate). **No AGPL-licensed source,
and no source copied from Inbox Zero, Kurrier, or any AGPL project, is included
here.** All transport patterns were reimplemented independently.

Licenses were read from each package's own metadata at install time
(resolved via `pnpm install`, 2026-07-12) and should be re-verified on upgrade.
The license policy is permissive-only (MIT / MIT-0 / ISC / Apache-2.0 / BSD /
0BSD / MPL-2.0 dev-transitive); `pnpm run license:check` fails the build on any
AGPL/GPL/LGPL/SSPL/BUSL/unknown license.

## Runtime dependencies

| Package      | Version | License | Role                                |
| ------------ | ------- | ------- | ----------------------------------- |
| `imapflow`   | 1.4.7   | MIT     | IMAP client (sync, drafts, IDLE)    |
| `nodemailer` | 9.0.3   | MIT-0   | SMTP submission + MIME construction |
| `mailparser` | 3.9.14  | MIT     | Streaming inbound MIME parsing      |
| `pg-boss`    | 12.26.0 | MIT     | Postgres-backed job queues          |
| `pg`         | 8.22.0  | MIT     | PostgreSQL driver (worker role)     |

## Development dependencies

| Package               | Version | License    |
| --------------------- | ------- | ---------- |
| `typescript`          | 5.9.3   | Apache-2.0 |
| `typescript-eslint`   | 8.46.0  | MIT        |
| `@eslint/js`          | 9.39.0  | MIT        |
| `eslint`              | 9.39.5  | MIT        |
| `prettier`            | 3.9.5   | MIT        |
| `vitest`              | 4.1.10  | MIT        |
| `@vitest/coverage-v8` | 4.1.10  | MIT        |
| `tsx`                 | 4.23.0  | MIT        |
| `@types/node`         | 22.20.1 | MIT        |
| `@types/nodemailer`   | 8.0.1   | MIT        |
| `@types/mailparser`   | 3.4.6   | MIT        |
| `@types/pg`           | 8.20.0  | MIT        |

## Notes

- `nodemailer` is published under **MIT-0** (MIT No Attribution), a permissive
  superset of MIT.
- A small number of dev-only transitive packages (e.g. `lightningcss` under the
  vitest/vite toolchain) are **MPL-2.0**, a weak, file-scoped copyleft that is
  neither shipped nor modified by this project. It is explicitly allowed by the
  policy; AGPL is not.
- The canonical database schema is owned by the sibling UI repository
  (`E-Mail-Composer-UI`) at merged commit
  `422485af44fa4606a7c0dbee798a9866b3fd0d8e`. The three Phase 3 migrations are
  checksum-pinned: transport foundation (20260713100000)
  `a2319ada8d471d09063b8e2bfbdb8c814e4ba49cecdee08c9bbd9b800aa8c72a`, contract
  hardening (20260714100000)
  `ee064f0b50d01897b8247a10edefc95bd0088862e3731693b19da7c851253977`, and the
  worker-transition grant (20260715100000)
  `ca15b9de01894ef784fad57f991a052e2da1fcdca435cc1a78463af34b3c0dba`. This
  backend does not vendor or re-own those migrations.
