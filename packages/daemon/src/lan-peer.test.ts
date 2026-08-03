// LAMA-223: pure parsers for tailnet IP detection. The spawn glue
// (`detectTailnetIp`) is exercised indirectly — these tests cover the
// string-parsing surface with representative /proc/net/route, `ip` and
// `tailscale status --json` output shapes.

import { describe, expect, test } from "bun:test";
import {
  parseDefaultRouteInterface,
  parseIpAddrOutput,
  parseTailscaleStatusJson,
} from "./lan-peer.ts";

describe("parseDefaultRouteInterface", () => {
  test("returns the default route interface from a typical /proc/net/route", () => {
    const routeTable = [
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
      "eth0\t00000000\tFE009AA9\t0003\t0\t0\t100\t00000000\t0\t0\t0",
      "eth0\t00009AA9\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0",
    ].join("\n");
    expect(parseDefaultRouteInterface(routeTable)).toBe("eth0");
  });

  test("picks the tailscale interface when it is the default route", () => {
    const routeTable = [
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
      "tailscale0\t00000000\t00009AA9\t0003\t0\t0\t50\t00000000\t0\t0\t0",
      "eth0\t00009AA9\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0",
    ].join("\n");
    expect(parseDefaultRouteInterface(routeTable)).toBe("tailscale0");
  });

  test("returns null when there is no default route", () => {
    const routeTable = [
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
      "eth0\t00009AA9\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0",
    ].join("\n");
    expect(parseDefaultRouteInterface(routeTable)).toBeNull();
  });

  test("returns null for an empty dump", () => {
    expect(parseDefaultRouteInterface("")).toBeNull();
  });
});

describe("parseIpAddrOutput", () => {
  const ipOutput = [
    "2: tailscale0    inet 100.64.0.5/32 scope global tailscale0\\       valid_lft forever preferred_lft forever",
    "2: tailscale0    inet6 fd7a:115c:a1e0::1/48 scope global dynamic       valid_lft 86399sec preferred_lft 86399sec",
    "3: eth0    inet 192.168.10.183/24 brd 192.168.10.255 scope global dynamic noprefixroute eth0\\       valid_lft 86399sec preferred_lft 86399sec",
  ].join("\n");

  test("returns the 100.x.x.x tailnet address when present", () => {
    expect(parseIpAddrOutput(ipOutput)).toBe("100.64.0.5");
  });

  test("returns null when only LAN addresses are present", () => {
    const lanOnly = ipOutput.replace("100.64.0.5/32", "10.0.0.7/32");
    expect(parseIpAddrOutput(lanOnly)).toBeNull();
  });

  test("returns null for empty output", () => {
    expect(parseIpAddrOutput("")).toBeNull();
  });

  // LAMA-223 P1-4: ISP CGNAT (100.64.0.0/10) on eth0 must not be
  // mis-classified as a tailnet address. The narrower /10 range still
  // covers the CGNAT range by coincidence, so the actual fix lives in
  // `detectTailnetIp` (tailscale0 first, then tailscale status --json,
  // then the default-route iface as a last resort). The pure parser
  // here only narrows the /8 to /10 — an address like 100.10.x.y is
  // rejected, the CGNAT-overlap case is handled by detection order.
  test("rejects addresses outside the 100.64-100.127 range (P1-4)", () => {
    const cgnat = [
      "3: eth0    inet 100.10.50.7/24 brd 100.10.50.255 scope global dynamic noprefixroute eth0",
    ].join("\n");
    expect(parseIpAddrOutput(cgnat)).toBeNull();
  });

  test("accepts the upper bound of the CGNAT /10 range", () => {
    const upper = [
      "2: tailscale0    inet 100.127.255.254/32 scope global tailscale0",
    ].join("\n");
    expect(parseIpAddrOutput(upper)).toBe("100.127.255.254");
  });
});

describe("parseTailscaleStatusJson", () => {
  test("reads Self.TailscaleIPs[0]", () => {
    const status = JSON.stringify({
      Self: {
        TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::1"],
      },
    });
    expect(parseTailscaleStatusJson(status)).toBe("100.64.0.5");
  });

  // LAMA-223 P1-4: prefer the IPv4 entry even when Tailscale lists the
  // ULA first. Many networks don't route the IPv6 ULAs.
  test("prefers the IPv4 entry when the IPv6 ULA is listed first (P1-4)", () => {
    const status = JSON.stringify({
      Self: {
        TailscaleIPs: ["fd7a:115c:a1e0::1", "100.64.0.5"],
      },
    });
    expect(parseTailscaleStatusJson(status)).toBe("100.64.0.5");
  });

  test("falls back to the IPv6 entry when no IPv4 is present", () => {
    const status = JSON.stringify({
      Self: {
        TailscaleIPs: ["fd7a:115c:a1e0::1"],
      },
    });
    expect(parseTailscaleStatusJson(status)).toBe("fd7a:115c:a1e0::1");
  });

  test("returns null for an empty TailscaleIPs list", () => {
    const status = JSON.stringify({ Self: { TailscaleIPs: [] } });
    expect(parseTailscaleStatusJson(status)).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseTailscaleStatusJson("{not json")).toBeNull();
    expect(parseTailscaleStatusJson("")).toBeNull();
  });
});
