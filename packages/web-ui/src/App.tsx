import { useEffect, useState } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Login } from "./components/Login.tsx";
import { Nav } from "./components/Nav.tsx";
import { MobileTabBar } from "./components/MobileTabBar.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Hosts } from "./pages/Hosts.tsx";
import { HostDetail } from "./pages/HostDetail.tsx";
import { Folders } from "./pages/Folders.tsx";
import { Backends } from "./pages/Backends.tsx";
import { AppBackups } from "./pages/Dotfiles.tsx";
import { AppTemplates } from "./pages/Presets.tsx";
import { Conflicts } from "./pages/Conflicts.tsx";
import { Operations } from "./pages/Operations.tsx";
import { Admin } from "./pages/Admin.tsx";
import { DataBrowser } from "./pages/DataBrowser.tsx";
import { getApiKey, probeSession, UNAUTHORIZED_EVENT } from "./api.ts";

type BootState = "loading" | "authed" | "anon";

export function App() {
  // LAMA-296 dual-mode boot:
  //   bearer — a stored API key is trusted instantly (classic flow; the
  //     first failing request bounces back to login via UNAUTHORIZED_EVENT).
  //   session — no stored key: probe GET /api/v1/auth/me with the cookie.
  //     There is NO dummy key in sessionStorage; session discovery is real
  //     auth metadata, and an absent/invalid session lands on the login
  //     screen (an invalid bearer never silently falls back to the cookie).
  const [boot, setBoot] = useState<BootState>(() =>
    getApiKey() !== null ? "authed" : "loading",
  );
  const [bootReachable, setBootReachable] = useState(true);
  // Bumped by the login screen's retry affordance to re-run the probe.
  const [probeTick, setProbeTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (getApiKey() !== null) {
      setBoot("authed");
      return;
    }
    setBoot("loading");
    void probeSession().then((result) => {
      if (cancelled) return;
      setBoot(result.mode === "session" ? "authed" : "anon");
      setBootReachable(result.mode === "session" ? true : result.reachable);
    });
    return () => {
      cancelled = true;
    };
  }, [probeTick]);

  // Drop back to the login screen whenever any API call or the WebSocket
  // reports the stored credential is no longer accepted (e.g. after a
  // server restart with a rotated key, or an expired/revoked web session).
  useEffect(() => {
    const onUnauthorized = () => setBoot("anon");
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (boot === "loading") {
    return (
      <div className="login-page">
        <div className="login-card">
          <p className="muted">Checking session…</p>
        </div>
      </div>
    );
  }

  const authed = boot === "authed";
  return (
    <HashRouter>
      <Routes>
        <Route
          path="/login"
          element={
            // LAMA-208: a stale #/login URL (bookmark, previous visit) must
            // not trap an already-authenticated session on the login form.
            // bootReachable=false means the probe found no server: offer a
            // retry affordance instead of a dead key form.
            authed ? (
              <Navigate to="/" replace />
            ) : (
              <Login
                onAuthenticated={() => setBoot("authed")}
                unreachable={!bootReachable}
                onRetryProbe={() => setProbeTick((t) => t + 1)}
              />
            )
          }
        />
        <Route
          path="/*"
          element={
            authed ? (
              <div className="app">
                <Nav />
                {/* LAMA-270: cmd+k palette — authed sessions only, mounted
                    inside the router so it can use useNavigate(). */}
                <CommandPalette />
                {/* LAMA-329 phase 3: `<main>` is the page landmark (the shell
                    had none) and the phone tab bar follows it in the DOM so
                    `position: sticky; bottom: 0` can hold it against the
                    viewport bottom. */}
                <main className="app-main">
                  <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/hosts" element={<Hosts />} />
                  <Route path="/hosts/:hostId" element={<HostDetail />} />
                  <Route path="/folders" element={<Folders />} />
                  <Route path="/backups" element={<Folders />} />
                  <Route path="/backends" element={<Backends />} />
                  <Route path="/apps/backups" element={<AppBackups />} />
                  <Route path="/apps/templates" element={<AppTemplates />} />
                  <Route path="/conflicts" element={<Conflicts />} />
                  <Route path="/operations" element={<Operations />} />
                  <Route path="/data" element={<DataBrowser />} />
                  <Route path="/admin" element={<Admin />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </main>
                <MobileTabBar />
              </div>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
      </Routes>
    </HashRouter>
  );
}
