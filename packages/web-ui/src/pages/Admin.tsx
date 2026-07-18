import { useState } from "react";
import { api } from "../api.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export function Admin() {
  const [days, setDays] = useState("30");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const parsed = Number.parseInt(days, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("days must be a non-negative integer");
      }
      const res = await api.pruneOperations(parsed * DAY_MS);
      setResult(`Deleted ${res.deleted} operation_log entries older than ${days} day(s)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Admin</h1>
      </div>
      <form className="form" onSubmit={onSubmit}>
        <label>
          Days to keep (older entries will be deleted)
          <input
            type="number"
            min="0"
            required
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </label>
        <div className="actions">
          <button type="submit" className="action primary" disabled={busy}>
            {busy ? "Pruning…" : "Prune"}
          </button>
        </div>
        {result && <div className="muted">{result}</div>}
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}
