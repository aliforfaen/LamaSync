// LAMA-329 phase 7: the honest connectivity banner.
//
// Mounted once, inside the authed shell, so every page carries the same
// statement about whether what it is showing can be trusted. The wording comes
// from `connectivity.ts`; this component only decides how it looks.

import { connectivityFrom, shouldShowConnectivityBanner } from "../connectivity.ts";
import { useTransportHealth } from "../hooks/useTransportHealth.ts";
import { useWebSocket } from "../hooks/useWebSocket.ts";

export function ConnectivityBanner() {
  const { state: socket } = useWebSocket();
  const { browserOnline, requestFailed } = useTransportHealth();

  const connectivity = connectivityFrom({ browserOnline, socket, requestFailed });
  if (!shouldShowConnectivityBanner(connectivity)) return null;

  return (
    <div
      className={`connectivity-banner connectivity-banner--${connectivity.level}`}
      role="status"
    >
      <strong>{connectivity.label}</strong>
      <span>{connectivity.detail}</span>
    </div>
  );
}
