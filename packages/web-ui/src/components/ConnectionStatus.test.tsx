// LAMA-334 item 5: the dashboard's connection state.
//
// Repo convention: bun:test + react-dom/server static markup (no jsdom, no
// @testing-library). The component is presentational, so a static render is
// the whole contract: an icon that is not the only signal, a state word that
// is not the transport constant, and a title that explains what the state
// means for the data.

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Connectivity } from "../connectivity.ts";
import { connectivityFrom } from "../connectivity.ts";
import { ConnectionStatus } from "./ConnectionStatus.tsx";

function render(connectivity: Connectivity): string {
  return renderToStaticMarkup(<ConnectionStatus connectivity={connectivity} />);
}

describe("ConnectionStatus (LAMA-334)", () => {
  it("never prints the raw WebSocket constant", () => {
    for (const facts of [
      { browserOnline: true, socket: "open" as const, requestFailed: false },
      { browserOnline: true, socket: "connecting" as const, requestFailed: false },
      { browserOnline: true, socket: "closed" as const, requestFailed: false },
      { browserOnline: false, socket: "closed" as const, requestFailed: true },
    ]) {
      const html = render(connectivityFrom(facts));
      for (const constant of [">OPEN<", ">CLOSED<", ">CONNECTING<", ">open<", ">closed<", ">connecting<"]) {
        expect(html).not.toContain(constant);
      }
    }
  });

  it("carries an icon AND the state word, so it is not colour-only", () => {
    const html = render(connectivityFrom({ browserOnline: true, socket: "open", requestFailed: false }));
    expect(html).toContain("<svg");
    expect(html).toContain("Connected");
    expect(html).toContain("conn-status--online");
    // The state is announced politely rather than interrupting the operator.
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("distinguishes a dropped event stream from an unreachable server", () => {
    const reconnecting = render(
      connectivityFrom({ browserOnline: true, socket: "closed", requestFailed: false }),
    );
    expect(reconnecting).toContain("Live updates paused");
    expect(reconnecting).toContain("conn-status--reconnecting");

    const unreachable = render(
      connectivityFrom({ browserOnline: true, socket: "closed", requestFailed: true }),
    );
    expect(unreachable).toContain("Server unreachable");
    expect(unreachable).toContain("conn-status--offline");

    const offline = render(
      connectivityFrom({ browserOnline: false, socket: "closed", requestFailed: true }),
    );
    expect(offline).toContain("Offline");
    expect(offline).toContain("conn-status--offline");
  });

  it("explains the state in the tooltip instead of repeating the label", () => {
    const connectivity = connectivityFrom({
      browserOnline: true,
      socket: "closed",
      requestFailed: false,
    });
    const html = render(connectivity);
    expect(html).toContain(`title="${connectivity.detail}"`);
    expect(connectivity.detail).not.toBe(connectivity.label);
  });

  it("renders a distinct icon per level", () => {
    const online = render(connectivityFrom({ browserOnline: true, socket: "open", requestFailed: false }));
    const reconnecting = render(
      connectivityFrom({ browserOnline: true, socket: "closed", requestFailed: false }),
    );
    const offline = render(
      connectivityFrom({ browserOnline: false, socket: "closed", requestFailed: false }),
    );
    expect(new Set([online, reconnecting, offline]).size).toBe(3);
    expect(reconnecting).not.toBe(offline);
  });
});
