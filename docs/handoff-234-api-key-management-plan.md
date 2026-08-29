# LAMA-234 — Managed API keys

Owner-approved implementation plan, 2026-08-29.

## Outcome

Replace the current all-clients-share-one-key model with named, independently
revocable credentials while retaining `LAMASYNC_API_KEY` as a break-glass
master credential. The Web UI is the first management surface; TUI key
management is explicitly out of scope.

The result should make a compromised device credential containable to that
device rather than grant the entire fleet control-plane access.

## Decisions already made

- Keep the environment `LAMASYNC_API_KEY` as the master/super-admin key. It
  remains valid for recovery and bootstrap, is never stored in SQLite, and is
  not editable or revealable in the Web UI.
- Add managed `admin` and `device` keys.
- Admin keys have the current full Web/API management surface and may manage
  other managed keys.
- Device keys are bound to one host. Enforce sensible host ownership on daemon
  operations, but keep recovery practical: an admin can explicitly revoke and
  re-pair a device rather than forcing an inflexible identity workflow.
- QR/pairing is the normal device-key issuance path. A pairing exchange mints
  a new device key; it must never distribute the master key.
- Preserve encrypted secret reveal for troubleshooting. Normal list/read
  responses never contain a secret; reveal is an explicit, audited admin
  action with no-store responses and a UI confirmation.
- Existing clients using the master key remain compatible until voluntarily
  re-paired. No forced cut-over in v1.
- No TUI key-management work in v1.

## Non-goals

- Multi-user accounts, OAuth, sessions, or a broad RBAC system.
- Automatic rotation or automatic rewriting of a remote device's
  `client.toml`.
- Removing the master key or making the fleet unrecoverable when the database
  is unavailable.
- Claiming to identify every existing master-key client exactly; the current
  shared key has no caller identity. Hosts without a bound managed device key
  can be shown as not yet enrolled, which is a useful migration heuristic.

## Credential model

### Master key

`LAMASYNC_API_KEY` authenticates as `master` / super-admin. It continues to
work for existing clients and all admin routes. Never return it from any route
or expose it in the UI. Production rotation remains an intentional deployment
operation (change `.env`, recreate server, reconfigure any remaining legacy
clients) rather than an in-app button in v1.

### Managed key record

Add an `api_keys` table with at least:

| Column | Purpose |
|---|---|
| `id` | Public opaque key ID / lookup prefix, not a secret |
| `name` | Human label, e.g. `cachy daemon` or `Admin laptop` |
| `kind` | `admin` or `device` |
| `host_id` | Required after device pairing; null for admin keys |
| `token_hash` | SHA-256 of a high-entropy generated token; used for auth |
| `token_enc` | Existing AES-GCM encrypted copy, used only by explicit reveal |
| `created_at`, `last_used_at`, `revealed_at` | Lifecycle metadata |
| `revoked_at`, `revoked_reason` | Soft-revocation audit trail |

Generate at least 256 bits of randomness. Include an opaque ID/prefix in the
token format so lookup does not require scanning every hash; use a
constant-time comparison for the resulting hash. Never log raw keys, hashes,
or ciphertext. `last_used_at` may be rate-limited (for example, one write per
few minutes per key) to avoid a SQLite write on every heartbeat.

`token_enc` deliberately trades strict hash-only storage for the owner-requested
reveal capability. Reuse `server/src/crypto.ts`; a reveal must fail closed if
the encrypted secret cannot be decrypted. Do not use that module's legacy
plaintext fallback for new API keys.

### Auth principal

Refactor `server/src/auth.ts` to resolve each Bearer token once into a typed
principal:

```ts
type AuthPrincipal =
  | { kind: "master"; keyId: null; hostId: null }
  | { kind: "admin"; keyId: string; hostId: null }
  | { kind: "device"; keyId: string; hostId: string };
```

The auth plugin attaches the principal to request context. Route helpers then
provide `requireAdmin()` and `requireDeviceHost(hostId)`. Mirror the same token
resolution in `server/src/ws.ts`; only master/admin keys may subscribe to the
fleet WebSocket in v1.

## Device authorization boundary

Do not attempt a vague "device keys can call daemon things" rule. Before
implementation, enumerate the daemon's actual client calls and put them in an
allowlist. It currently needs config, self-registration, heartbeat/operation
reports, its own action queue and completions, its own dotfile uploads,
conflicts, snapshots, restore jobs, and release checks.

For every host-bearing endpoint, a device principal must match the supplied or
body host ID. For rows addressed only by a resource ID (such as an action or
restore job), verify server-side that the row belongs to that device host
before returning or mutating it. Device keys must not receive full fleet lists,
backends/secrets, key management, destructive admin operations, or another
host's config/actions/reports.

The initial implementation can keep resource-level authorization helpers close
to the affected routes. Do not rely on a client-provided `hostId` without
checking it against the principal.

## Pairing flow

Keep the existing short-lived, single-use QR/code flow and stable response
shape (`{ apiKey }`), but change exchange semantics:

1. An admin creates the code in the Web UI.
2. `lamasync register` submits its local host ID and hostname with the
   auth-exempt exchange request.
3. The server atomically claims the code, creates a managed `device` key
   bound to that host ID, and returns it as `apiKey`.
4. The CLI writes that key to `client.toml`; subsequent `POST /register` and
   daemon calls must match the key's host binding.

If a device needs replacing, an admin revokes its old key and uses Pair device
again. The master key remains a recovery path for legacy clients and failures.

## API surface

Add a flat `server/src/routes/api-keys.ts` plugin under `/api/v1` with Swagger
detail blocks and agent-skill documentation:

| Method | Route | Purpose |
|---|---|---|
| GET | `/api-keys` | Admin list of masked managed-key metadata |
| POST | `/api-keys` | Admin creates an admin key; secret returned once |
| POST | `/api-keys/:id/reveal` | Explicit admin reveal of encrypted secret |
| POST | `/api-keys/:id/revoke` | Soft revoke; future requests return 401 |

Pairing exchange gains a validated body with the device host identity. It still
returns `{ apiKey }` so the registration client has a stable result shape.

Consider a small `GET /auth/me` only if the UI needs to identify its current
credential type. It is not required to ship v1.

Every secret-bearing response must send `Cache-Control: no-store`; the UI must
hold a revealed value only in component state and clear it on close/navigation.

## Web UI — Admin, v1

Add an **Access keys** section to `pages/Admin.tsx`:

- Table: label, type, bound device, created, last used, status, and masked
  fingerprint. No raw secrets in the table or normal API responses.
- **Create admin key**: label → confirmation/reveal modal with copy affordance.
- **Pair device** continues to use the existing QR modal, now issuing a
  host-bound device key at exchange.
- **Reveal**: explanatory confirmation that the secret will be placed in the
  clipboard/view; request only after confirmation; clear UI state on close.
- **Revoke**: destructive confirmation, optional reason, clear explanation
  that the device will receive 401 until re-paired.
- Migration panel: list registered hosts with a managed device key binding and
  flag hosts without one as “not enrolled yet” (heuristic, not proof that they
  use the master key).

Keep management in the Web UI. The existing CLI/TUI key stays usable for
normal operations and client registration; no interactive TUI key screen is
part of this issue.

## Implementation sequence

1. Add shared key/principal types, `api_keys` schema + migration, token
   generation/hash/encryption helpers, and hermetic unit tests.
2. Refactor REST and WebSocket authentication to resolve master/admin/device
   principals without changing existing master-key behavior.
3. Add route-level device allowlists and resource ownership checks, with tests
   proving cross-host access returns 403/404 as appropriate.
4. Add key lifecycle routes and audit/reveal behavior; document every route
   before the strict skill-drift gate runs.
5. Update pairing exchange and `lamasync register`; test that pairing never
   returns the master key and that a paired device cannot act as another host.
6. Build the Admin access-key UI and migrate the pairing modal. Add focused
   UI/helper tests for no secret persistence and destructive confirmations.
7. Update `ARCHITECTURE.md`, `docs/features.md`, agent skill safety/API docs,
   and the production/recovery documentation. Run `tsc`, web build, full
   tests, strict drift, plus a server boot smoke test.

## Acceptance criteria

- A new QR-paired device receives a unique key, never the master key.
- Revoking one device key returns 401 for that device while other devices and
  admin keys continue working.
- A device key cannot read/mutate another host's configuration, actions,
  reports, restore jobs, or key management.
- An admin key can manage the Web UI and managed keys; a device key cannot.
- A raw managed key is available only on creation or an explicit reveal; it is
  encrypted at rest and absent from logs, lists, normal reads, and browser
  persistence.
- Existing master-key clients keep working until re-paired.
- The route reference and strict skill-drift check are green.
