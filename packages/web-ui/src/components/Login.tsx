import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, ApiError, setApiKey } from "../api.ts";

interface LoginProps {
  onAuthenticated: () => void;
}

export function Login({ onAuthenticated }: LoginProps) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // UX workstream 4: unchecked (default) keeps the key in sessionStorage;
  // checked persists it to localStorage so new tabs stay signed in.
  const [remember, setRemember] = useState(false);
  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      setApiKey(key.trim(), remember);
      await apiGet("/health");
      navigate("/");
      onAuthenticated();
    } catch (err) {
      setApiKey("");
      setError(
        err instanceof ApiError && err.status === 401
          ? "Invalid API key"
          : "Unable to reach the server",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>LamaSync</h1>
        <label className="muted" htmlFor="api-key">API key</label>
        <input
          id="api-key"
          type="password"
          autoComplete="off"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          required
        />
        {error && <div className="error">{error}</div>}
        <label className="login-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />{" "}
          Remember this device (keep me signed in)
        </label>
        <p className="muted">
          Set on the server via <code>LAMASYNC_API_KEY</code> (docker <code>.env</code> or
          the server config). One key for the whole fleet — the same key works on
          every client.
        </p>
        <button type="submit" disabled={loading || key.trim().length === 0}>
          {loading ? "Verifying…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
