// LAMA-334: the two transport facts that are not the WebSocket.
//
// `navigator.onLine` says an interface is up (not that the server is
// reachable), and "a request failed" is published by `api.ts` when a fetch
// actually rejects. Both used to be tracked inside `ConnectivityBanner`;
// the dashboard's connection pill needs the same two facts to render the same
// sentence, and two copies of this listener pair is how the banner and the
// pill would eventually disagree.

import { useEffect, useState } from "react";
import {
  REQUEST_FAILED_EVENT,
  REQUEST_SUCCEEDED_EVENT,
} from "../api.ts";

export interface TransportHealth {
  browserOnline: boolean;
  requestFailed: boolean;
}

export function useTransportHealth(): TransportHealth {
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
    // Any successful request clears the flag: the server is answering again,
    // so "Server unreachable" is no longer true.
    const onSuccess = () => setRequestFailed(false);
    window.addEventListener(REQUEST_FAILED_EVENT, onFailure);
    window.addEventListener(REQUEST_SUCCEEDED_EVENT, onSuccess);
    return () => {
      window.removeEventListener(REQUEST_FAILED_EVENT, onFailure);
      window.removeEventListener(REQUEST_SUCCEEDED_EVENT, onSuccess);
    };
  }, []);

  return { browserOnline, requestFailed };
}
