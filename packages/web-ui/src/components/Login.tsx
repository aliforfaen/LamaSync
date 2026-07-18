import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, setApiKey } from "../api.ts";

interface LoginProps {
  onAuthenticated: () => void;
}

export function Login({ onAuthenticated }: LoginProps) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      setApiKey(key.trim());
      await apiGet("/health");
      navigate("/");
      onAuthenticated();
    } catch (err) {
      setApiKey("");
      setError(
        err instanceof Error && err.message.includes("401")
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
        <button type="submit" disabled={loading || key.trim().length === 0}>
          {loading ? "Verifying…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
