// LAMA-334 item 5: the dashboard's connection state, stated rather than
// spelled. The old control was a pill reading the raw WebSocket constant
// ("OPEN"/"CONNECTING"/"CLOSED"), which is a transport detail, not an answer
// to "is this fleet live?".
//
// This renders the SAME derivation the connectivity banner uses
// (`connectivity.ts`), so the two surfaces cannot disagree, and it says the
// state three ways: an icon, the state word, and a title carrying the sentence
// that explains what the state means for the data. Colour is decoration on top
// of those, never the signal.

import type { Connectivity } from "../connectivity.ts";
import {
  IconConnectionLiveFilled,
  IconConnectionOfflineFilled,
  IconSyncFilled,
} from "./icons.tsx";

export interface ConnectionStatusProps {
  connectivity: Connectivity;
}

export function ConnectionStatus({ connectivity }: ConnectionStatusProps) {
  const Icon =
    connectivity.level === "online"
      ? IconConnectionLiveFilled
      : connectivity.level === "reconnecting"
        ? IconSyncFilled
        : IconConnectionOfflineFilled;

  return (
    <span
      className={`conn-status conn-status--${connectivity.level}`}
      role="status"
      aria-live="polite"
      title={connectivity.detail}
    >
      <Icon className="conn-status-icon" />
      <span className="conn-status-label">{connectivity.label}</span>
    </span>
  );
}
