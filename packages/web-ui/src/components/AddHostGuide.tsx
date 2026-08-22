import { useState } from "react";
import { getApiKey } from "../api.ts";

const INSTALL_URL =
  "https://raw.githubusercontent.com/aliforfaen/LamaSync/master/packaging/install/install.sh";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API can be unavailable (non-HTTPS, permissions). Fall back
      // to a hidden textarea + execCommand.
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button type="button" className="action copy-btn" onClick={onCopy}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CommandBlock({ command }: { command: string }) {
  return (
    <div className="command-block">
      <pre>{command}</pre>
      <CopyButton text={command} />
    </div>
  );
}

/**
 * AddHostGuide — copy-pasteable terminal commands for onboarding a new
 * machine. The server URL is derived from where this UI is being served;
 * the API key starts masked and can be revealed (and copied) on demand.
 */
export function AddHostGuide() {
  const [showKey, setShowKey] = useState(false);
  const serverUrl = window.location.origin;
  const key = getApiKey();
  const shownKey = showKey && key ? key : "<API_KEY>";

  const installCmd = [
    `curl -sSL ${INSTALL_URL} | bash -s -- \\`,
    `  --server-url ${serverUrl} \\`,
    `  --api-key ${shownKey} \\`,
    `  --with-tui`,
  ].join("\n");

  const statusCmd = "systemctl --user status lamasyncd";

  const clientToml = [
    `serverUrl = "${serverUrl}"`,
    `apiKey = "${shownKey}"`,
    `hostname = "my-host"`,
  ].join("\n");

  return (
    <div className="guide-panel">
      <h2>Add a device</h2>
      <p className="muted">
        Devices register themselves — there is no server-side "add" form. Run the
        installer on the machine you want to add; it installs{" "}
        <code>lamasyncd</code>, writes <code>~/.config/lamasync/client.toml</code>,
        and starts a systemd user service.
      </p>

      <h3>1. Install &amp; register (on the new machine)</h3>
      <CommandBlock command={installCmd} />
      <p className="muted">
        Drop <code>--with-tui</code> if you don't want the terminal UI.{" "}
        {key && (
          <button
            type="button"
            className="action"
            onClick={() => setShowKey((s) => !s)}
          >
            {showKey ? "Hide API key" : "Show command with my API key"}
          </button>
        )}
      </p>

      <h3>2. Check the daemon</h3>
      <CommandBlock command={statusCmd} />

      <h3>3. Confirm it showed up</h3>
      <p className="muted">
        The service heartbeats every 30 seconds — the new device appears in this
        list (and on the dashboard) within a minute.
      </p>

      <details>
        <summary>Manual setup (no curl | bash)</summary>
        <p className="muted">
          Download <code>lamasyncd</code> from the GitHub release, then write{" "}
          <code>~/.config/lamasync/client.toml</code>:
        </p>
        <CommandBlock command={clientToml} />
        <p className="muted">
          Run <code>lamasyncd</code> in the foreground, or install the systemd
          unit from <code>packaging/systemd/lamasyncd.service</code>.
        </p>
      </details>
    </div>
  );
}
