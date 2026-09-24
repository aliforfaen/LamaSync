// LAMA-346 Stage 2f — the Admin panel for the operator's SEED PILOT.
//
// Why this exists as its own surface: the archive transport is implemented and
// proven in the disposable E2E, but it has never run between two real machines.
// Rather than a build flag that would open every folder at once, execution is
// opened by an EXPLICIT authorization of exactly ONE folder and ONE source/target
// pair, together with the TEMPORARY SEED SPACE it may use — an EXISTING S3
// backend row plus the bucket the fleet is allowed to write to. Nothing here
// hardcodes a bucket, infers the space from the folder being seeded, or asks for
// a second copy of a secret the backend row already holds.
//
// The panel also owns the READINESS PROBE, and that is not decoration: an
// existing backend's key may be scoped to a different bucket (the generic
// backends "test connection" lists every bucket in the account, which such a key
// cannot do). The probe is bucket-scoped, touches one object under the seed
// namespace and removes it again, and the pilot refuses to run until it passes.
//
// No response this panel reads contains a credential — the options block carries
// a backend's access key ID (an identifier the backends list already exposes) and
// a `hasSecret` boolean.

import { useCallback, useEffect, useState } from "react";
import type { SeedPilotView } from "@lamasync/core";
import { api } from "../api.ts";

/** The API calls the panel needs, so a test can drive it DOM-free. */
export interface SeedPilotServices {
  read: () => Promise<SeedPilotView>;
  save: (body: {
    enabled: boolean;
    folderId: string | null;
    sourceHostId: string | null;
    targetHostId: string | null;
    backendId: string | null;
    bucket: string | null;
    confirm: true;
  }) => Promise<SeedPilotView>;
  clear: () => Promise<SeedPilotView>;
  probe: () => Promise<SeedPilotView>;
}

const services: SeedPilotServices = {
  read: () => api.seedPilot(),
  save: (body) => api.saveSeedPilot(body),
  clear: () => api.clearSeedPilot(),
  probe: () => api.probeSeedPilot(),
};

export interface SeedPilotDraft {
  enabled: boolean;
  folderId: string;
  sourceHostId: string;
  targetHostId: string;
  backendId: string;
  bucket: string;
}

/**
 * The draft the form edits, from the stored config.
 *
 * Empty strings rather than nulls, because these are bound to `<select>` and
 * `<input>` values; the save call converts them back, so an empty choice is a
 * REFUSAL at the API boundary rather than a null that silently widens the
 * authorization.
 */
export function seedPilotDraft(view: SeedPilotView | null): SeedPilotDraft {
  const config = view?.config ?? null;
  return {
    enabled: config?.enabled ?? false,
    folderId: config?.folderId ?? "",
    sourceHostId: config?.sourceHostId ?? "",
    targetHostId: config?.targetHostId ?? "",
    backendId: config?.backendId ?? "",
    bucket: config?.bucket ?? "",
  };
}

/** Turn the draft into the exact request body the API validates. */
export function seedPilotSaveBody(draft: SeedPilotDraft): {
  enabled: boolean;
  folderId: string | null;
  sourceHostId: string | null;
  targetHostId: string | null;
  backendId: string | null;
  bucket: string | null;
  confirm: true;
} {
  const orNull = (value: string): string | null => (value.trim().length === 0 ? null : value.trim());
  return {
    enabled: draft.enabled,
    folderId: orNull(draft.folderId),
    sourceHostId: orNull(draft.sourceHostId),
    targetHostId: orNull(draft.targetHostId),
    backendId: orNull(draft.backendId),
    bucket: orNull(draft.bucket),
    confirm: true,
  };
}

/** The readiness line, always stating the bucket the verdict is about. */
export function seedPilotReadinessSentence(view: SeedPilotView | null): string {
  const readiness = view?.config.readiness ?? null;
  if (readiness === null || readiness.state === "unknown") {
    return "The temporary seed space has not been probed yet, so no seed may run. Choose Test seed space.";
  }
  const where = readiness.bucket === null ? "the configured bucket" : readiness.bucket;
  return readiness.state === "ready"
    ? `The temporary seed space works: the configured backend can write to and delete from ${where}.`
    : `The temporary seed space FAILED its probe (${where}): ${readiness.message ?? "no reason recorded"}`;
}

/** A one-line status for the card header. */
export function seedPilotStatusSentence(view: SeedPilotView | null): string {
  if (view === null) return "Loading…";
  return view.summary;
}

export function SeedPilotPanel(): React.ReactElement {
  const [view, setView] = useState<SeedPilotView | null>(null);
  const [draft, setDraft] = useState<SeedPilotDraft>(seedPilotDraft(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((next: SeedPilotView): void => {
    setView(next);
    setDraft(seedPilotDraft(next));
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      apply(await services.read());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apply]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<SeedPilotView>, success: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      apply(await action());
      setNotice(success);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const options = view?.options ?? null;
  const backends = (options?.backends ?? []).filter((backend) => backend.kind === "s3");

  return (
    <section className="section">
      <h2>Seed pilot (one folder at a time)</h2>
      <p className="muted">
        Initial seeding moves a whole folder between two devices through a temporary object space. It is
        off for every folder until you authorize exactly ONE folder and ONE source/target pair here, and
        until the temporary seed space has been probed. Nothing is inferred: the source device, the
        folder, the storage backend and the bucket are all your explicit choices, and the backend's own
        stored credentials are used — you never enter a second copy of a secret.
      </p>
      <p className="muted">{seedPilotStatusSentence(view)}</p>
      <p className={view?.config.readiness.state === "ready" ? "muted" : "folder-seed-warning"}>
        {seedPilotReadinessSentence(view)}
      </p>

      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => services.save(seedPilotSaveBody(draft)), "Seed pilot saved.");
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          {" "}Enable the seed pilot for the folder and pair below
        </label>
        <div className="form-row">
          <label>
            Folder
            <select
              value={draft.folderId}
              onChange={(event) => setDraft({ ...draft, folderId: event.target.value })}
            >
              <option value="">Choose a folder…</option>
              {(options?.folders ?? []).map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name} ({folder.type})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            Source device (the device that holds the data)
            <select
              value={draft.sourceHostId}
              onChange={(event) => setDraft({ ...draft, sourceHostId: event.target.value })}
            >
              <option value="">Choose the source…</option>
              {(options?.hosts ?? []).map((host) => (
                <option key={host.id} value={host.id}>
                  {host.hostname} ({host.status})
                </option>
              ))}
            </select>
          </label>
          <label>
            Target device (the device that receives the seed)
            <select
              value={draft.targetHostId}
              onChange={(event) => setDraft({ ...draft, targetHostId: event.target.value })}
            >
              <option value="">Choose the target…</option>
              {(options?.hosts ?? []).map((host) => (
                <option key={host.id} value={host.id}>
                  {host.hostname} ({host.status})
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted">
          The pair is ORDERED: swapping the two devices authorizes nothing, because the direction decides
          which tree wins.
        </p>
        <div className="form-row">
          <label>
            Temporary seed space: existing S3 backend
            <select
              value={draft.backendId}
              onChange={(event) => setDraft({ ...draft, backendId: event.target.value })}
            >
              <option value="">Choose a backend…</option>
              {backends.map((backend) => (
                <option key={backend.id} value={backend.id}>
                  {backend.name}
                  {backend.endpoint === null ? "" : ` — ${backend.endpoint}`}
                  {backend.hasSecret ? "" : " (no stored secret)"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Bucket
            <input
              value={draft.bucket}
              onChange={(event) => setDraft({ ...draft, bucket: event.target.value })}
              placeholder="the bucket this fleet may use for seeds"
              autoComplete="off"
            />
          </label>
        </div>
        <p className="muted">
          Use a bucket whose own lifecycle rules delete temporary objects (for example: hide after 7 days,
          then delete). LamaSync deletes a job's objects itself as soon as the job is terminal; the
          bucket's rules are the independent backstop for anything a stopped device could not remove.
        </p>
        <div className="actions">
          <button type="submit" className="action primary" disabled={busy}>
            {busy ? "Saving…" : "Save seed pilot"}
          </button>
          <button
            type="button"
            className="action"
            disabled={busy || view?.config.enabled !== true}
            onClick={() => void run(() => services.probe(), "Seed space probed.")}
          >
            Test seed space
          </button>
          <button
            type="button"
            className="action"
            disabled={busy || view?.config.enabled !== true}
            onClick={() => void run(() => services.clear(), "Seed pilot switched off.")}
          >
            Switch off
          </button>
        </div>
        {notice ? <div className="muted">{notice}</div> : null}
        {error ? <div className="error">{error}</div> : null}
      </form>
    </section>
  );
}
