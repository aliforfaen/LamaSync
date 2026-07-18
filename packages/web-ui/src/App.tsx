import { useState } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Login } from "./components/Login.tsx";
import { Nav } from "./components/Nav.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Folders } from "./pages/Folders.tsx";
import { Dotfiles } from "./pages/Dotfiles.tsx";
import { Conflicts } from "./pages/Conflicts.tsx";
import { Admin } from "./pages/Admin.tsx";
import { getApiKey } from "./api.ts";

export function App() {
  const [authenticated, setAuthenticated] = useState(() => getApiKey() !== null);
  const authed = authenticated;
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<Login onAuthenticated={() => setAuthenticated(true)} />} />
        <Route
          path="/*"
          element={
            authed ? (
              <div className="app">
                <Nav />
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/folders" element={<Folders />} />
                  <Route path="/dotfiles" element={<Dotfiles />} />
                  <Route path="/conflicts" element={<Conflicts />} />
                  <Route path="/admin" element={<Admin />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
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
