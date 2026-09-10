// LAMA-329 phase 7: the honest connectivity banner.
//
// Mounted once, inside the authed shell, so every page carries the same
// statement about whether what it is showing can be trusted. The wording comes
// from `connectivity.ts`; this component only decides how it looks.

import { useEffect, useState } from "react";
import {
  REQUEST_FAILED_EVENT,
  REQUEST_SUCCEEDED_EVENT,
} from "../api.ts";
import { connectivityFrom, shouldShowConnectivityBanner } from "../connectivity.ts";
import { useWebSocket } from "../hooks/useWebSocket.ts";

export function ConnectivityBanner() {
  const { state: socket } = useWebSocket();
  const [browserOnline, setBrowserOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [requestFailed, setRequestFailed] = useState(false);

  useEffect(() => {
    const goOnline = () => setBrowserOnline(true);
    const goOffline = () => setBrowserOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  useEffect(() => {
    const onFailure = () => setRequestFailed(true);
    const onSuccess = () => setRequestFailed(false);
    window.addEventListener(REQUEST_FAILED_EVENT, onFailure);
    window.addEventListener(REQUEST_SUCCEEDED_EVENT, onSuccess);
    return () => {
      window.removeEventListener(REQUEST_FAILED_EVENT, onFailure);
      window.removeEventListener(REQUEST_SUCCEEDED_EVENT, onSuccess);
    };
  }, []);

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
