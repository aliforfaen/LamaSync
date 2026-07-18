import { NavLink } from "react-router-dom";
import { clearApiKey } from "../api.ts";

export function Nav() {
  return (
    <nav className="nav">
      <span className="brand">LamaSync</span>
      <NavLink to="/" end>Dashboard</NavLink>
      <NavLink to="/folders">Folders</NavLink>
      <NavLink to="/dotfiles">Dotfiles</NavLink>
      <NavLink to="/conflicts">Conflicts</NavLink>
      <NavLink to="/admin">Admin</NavLink>
      <button
        type="button"
        className="action"
        onClick={() => {
          clearApiKey();
          window.location.hash = "#/login";
          window.location.reload();
        }}
      >
        Sign out
      </button>
    </nav>
  );
}
