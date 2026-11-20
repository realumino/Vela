/**
 * The WARP device registration, the MASQUE enrollment, and the outbound.
 *
 * WHY a stub fetcher: the exchange is two HTTP calls whose request shapes
 * (headers, bodies, key encodings) and response parsing are the whole
 * contract. Canned Cloudflare responses keep the test hermetic and pin the
 * field names a re-implementation usually gets wrong.
 */

import { describe, expect, it } from "vitest";

import {
  createWarpMasque,
  endpointHost,
  enrollMasque,
  generateP256KeyPair,
  registerWarp,
  supportsWarpMasque,
  WARP_API,
  WARP_MASQUE_SNI,
  warpMasqueOutbound,
} from "../../src/services/warp_service";

/** WHAT: a device-creation response. */
function deviceResponse(): Response {
  return Response.json({ id: "dev-1", token: "tok-1", config: { client_id: "UVHc" } });
}

/** WHAT: a MASQUE enrollment response with the fields the outbound needs. */
function enrollmentResponse(): Response {
  return Response.json(
    {
      config: {
        peers: [
          {
            public_key:
              "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEIw==\n-----END PUBLIC KEY-----\n",
            endpoint: { v4: "162.159.198.2:0", v6: "[2606:4700:103::2]:0" },
          },
        ],
        interface: {
          addresses: {
            v4: "172.16.0.2",
            v6: "2606:4700:110:8a78:72d9:6e7f:da52:294f",
          },
        },
      },
    },
    { status: 200 },
  );
}

/** WHAT: a fetch stub that plays the responses in order and records requests. */
function stub(responses: Array<() => Response>): {
  fetcher: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const responder = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return responder!();
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("registerWarp", () => {
  it("creates a device with a one-off Curve25519-shaped key", async () => {
    const { fetcher, calls } = stub([deviceResponse]);
    const device = await registerWarp(fetcher, new Date("2026-11-11T00:00:00Z"));

    expect(device).toEqual({ id: "dev-1", token: "tok-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(WARP_API);
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["CF-Client-Version"]).toBe("a-6.10-2158");
    expect(headers["User-Agent"]).toBe("okhttp/3.12.1");

    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body["tos"]).toBe("2026-11-11T00:00:00.000Z");
    expect(body["model"]).toBe("PC");
    expect(atob(String(body["key"]))).toHaveLength(32);
  });

  it("fails loudly on a rejected registration", async () => {
    const { fetcher } = stub([() => new Response("no", { status: 429 })]);
    await expect(registerWarp(fetcher, new Date())).rejects.toThrow(/HTTP 429/);
  });

  it("fails when the response lacks the credentials", async () => {
    const { fetcher } = stub([() => Response.json({ id: "dev-1" })]);
    await expect(registerWarp(fetcher, new Date())).rejects.toThrow(/missing token/);
  });
});

describe("enrollMasque", () => {
  it("patches the device to a P-256 MASQUE key", async () => {
    const keys = await generateP256KeyPair();
    const { fetcher, calls } = stub([enrollmentResponse]);
    const enrollment = await enrollMasque(
      fetcher,
      { id: "dev-1", token: "tok-1" },
      keys,
    );

    expect(calls[0].url).toBe(`${WARP_API}/dev-1`);
    expect(calls[0].init?.method).toBe("PATCH");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-1");

    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      key: keys.public_key,
      key_type: "secp256r1",
      tunnel_type: "masque",
    });
    // The enrolled key must be a P-256 SPKI, not a Curve25519 blob.
    expect(atob(String(body["key"]))).toHaveLength(91);

    expect(enrollment).toEqual({
      peer_public_key:
        "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEIw==\n-----END PUBLIC KEY-----\n",
      endpoints: { v4: "162.159.198.2", v6: "2606:4700:103::2" },
      // Both interface addresses survive; the edge choice belongs to the
      // outbound, not to the enrollment.
      addresses: ["172.16.0.2/32", "2606:4700:110:8a78:72d9:6e7f:da52:294f/128"],
    });
  });

  it("falls back to the v4 edge when the response carries no v6 one", async () => {
    const keys = await generateP256KeyPair();
    const { fetcher } = stub([
      () =>
        Response.json({
          config: {
            peers: [
              {
                public_key: "pub",
                endpoint: { v4: "162.159.198.2:0" },
              },
            ],
            interface: {
              addresses: { v4: "172.16.0.2", v6: "2606:4700:110::1" },
            },
          },
        }),
    ]);
    const enrollment = await enrollMasque(fetcher, { id: "d", token: "t" }, keys);
    expect(enrollment.endpoints).toEqual({ v4: "162.159.198.2", v6: null });
  });

  it("fails when the response lacks the fields a tunnel needs", async () => {
    const keys = await generateP256KeyPair();
    const noConfig = stub([() => Response.json({})]);
    await expect(
      enrollMasque(noConfig.fetcher, { id: "d", token: "t" }, keys),
    ).rejects.toThrow(/no config/);

    const noEndpoint = stub([
      () =>
        Response.json({
          config: {
            peers: [{ public_key: "x", endpoint: {} }],
            interface: { addresses: { v4: "172.16.0.2", v6: "::1" } },
          },
        }),
    ]);
    await expect(
      enrollMasque(noEndpoint.fetcher, { id: "d", token: "t" }, keys),
    ).rejects.toThrow(/no peer endpoint/);
  });
});

describe("createWarpMasque", () => {
  it("returns a private key that belongs to the enrolled public key", async () => {
    const { fetcher, calls } = stub([deviceResponse, enrollmentResponse]);
    const registration = await createWarpMasque(fetcher, new Date());

    expect(calls).toHaveLength(2);
    const enrolled = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>;
    const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(atob(registration.private_key), (char) => char.charCodeAt(0)),
      algorithm,
      false,
      ["sign"],
    );
    const publicKey = await crypto.subtle.importKey(
      "spki",
      Uint8Array.from(atob(String(enrolled["key"])), (char) => char.charCodeAt(0)),
      algorithm,
      false,
      ["verify"],
    );
    const message = new TextEncoder().encode("warp");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      message,
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        message,
      ),
    ).toBe(true);
  });
});

describe("endpointHost", () => {
  it("strips the port the API reports as zero", () => {
    expect(endpointHost("162.159.198.2:0")).toBe("162.159.198.2");
    expect(endpointHost("[2606:4700:103::2]:0")).toBe("2606:4700:103::2");
    expect(endpointHost("162.159.198.2")).toBe("162.159.198.2");
    expect(endpointHost("")).toBeNull();
    expect(endpointHost(7)).toBeNull();
  });
});

describe("supportsWarpMasque", () => {
  it("compares dotted versions numerically", () => {
    expect(supportsWarpMasque("26.11.9")).toBe(true);
    expect(supportsWarpMasque("v26.10.21")).toBe(true);
    expect(supportsWarpMasque("26.10.20")).toBe(false);
    expect(supportsWarpMasque("26.9.30")).toBe(false);
    expect(supportsWarpMasque("25.12.1")).toBe(false);
    expect(supportsWarpMasque("")).toBe(false);
    expect(supportsWarpMasque(null)).toBe(false);
    expect(supportsWarpMasque("not-a-version")).toBe(false);
  });
});

describe("warpMasqueOutbound", () => {
  it("builds the masque outbound with the pinned edge key", async () => {
    const { fetcher } = stub([deviceResponse, enrollmentResponse]);
    const registration = await createWarpMasque(fetcher, new Date());
    const outbound = warpMasqueOutbound("warp", registration);

    expect(outbound).toMatchObject({
      tag: "warp",
      protocol: "masque",
      settings: {
        address: "2606:4700:103::2",
        port: 443,
        remoteDNS: [
          "1.1.1.1",
          "1.0.0.1",
          "2606:4700:4700::1111",
          "2606:4700:4700::1001",
        ],
      },
      streamSettings: {
        network: "masque",
        security: "tls",
        tlsSettings: { serverName: WARP_MASQUE_SNI, alpn: ["h3"] },
        masqueSettings: {
          warp: {
            privateKey: registration.private_key,
            publicKey: registration.peer_public_key,
            address: registration.addresses,
          },
        },
      },
    });
  });

  it("dials the IPv4 edge without dropping the IPv6 interface address", async () => {
    const { fetcher } = stub([deviceResponse, enrollmentResponse]);
    const registration = await createWarpMasque(fetcher, new Date());
    const outbound = warpMasqueOutbound("warp", registration, "ipv4");

    expect(outbound).toMatchObject({
      settings: { address: "162.159.198.2" },
      streamSettings: {
        masqueSettings: {
          warp: {
            address: [
              "172.16.0.2/32",
              "2606:4700:110:8a78:72d9:6e7f:da52:294f/128",
            ],
          },
        },
      },
    });
  });

  it("falls back to the IPv4 edge when the registration offers no IPv6 one", async () => {
    const { fetcher } = stub([
      deviceResponse,
      () =>
        Response.json({
          config: {
            peers: [{ public_key: "pub", endpoint: { v4: "162.159.198.2:0" } }],
            interface: { addresses: { v4: "172.16.0.2", v6: "2606:4700:110::1" } },
          },
        }),
    ]);
    const registration = await createWarpMasque(fetcher, new Date());

    expect(warpMasqueOutbound("warp", registration)).toMatchObject({
      settings: { address: "162.159.198.2" },
    });
  });

  it("refuses an IPv4 edge the registration does not offer", async () => {
    const { fetcher } = stub([
      deviceResponse,
      () =>
        Response.json({
          config: {
            peers: [{ public_key: "pub", endpoint: { v6: "[2606:4700:103::2]:0" } }],
            interface: { addresses: { v4: "172.16.0.2", v6: "2606:4700:110::1" } },
          },
        }),
    ]);
    const registration = await createWarpMasque(fetcher, new Date());

    expect(() => warpMasqueOutbound("warp", registration, "ipv4")).toThrow(
      /no ipv4 edge/,
    );
  });
});
