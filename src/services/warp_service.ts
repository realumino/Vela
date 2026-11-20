/**
 * Cloudflare WARP registration for a node's outbound, as a MASQUE tunnel.
 *
 * WHY this exists: a WARP exit is one outbound object, but obtaining it
 * requires a device registration with Cloudflare's client API (the same
 * exchange wgcf performs) plus a switch of that device to MASQUE. Doing it
 * in the plane means the admin pastes nothing and the device key is
 * generated here, goes into the authored config, and reaches the node
 * through the normal render.
 *
 * WHY two calls and not one: `/reg` creates the device with an ordinary
 * Curve25519-shaped key because that is the only shape that endpoint takes
 * for a new account; `PATCH /reg/{id}` then replaces it with a P-256 key and
 * `tunnel_type: "masque"`. Cloudflare authenticates the tunnel with a
 * client certificate derived from that P-256 key and pins its own edge key,
 * so the WireGuard key, the `client_id`, and the three "reserved" bytes are
 * never used after the switch.
 *
 * WHY the SPI/keys the way they are: Xray's `masqueSettings.warp` wants a
 * PKCS#8 (or SEC 1) private key and the edge's SubjectPublicKeyInfo, each
 * base64 or PEM. WebCrypto exports exactly those DER shapes, so the plane
 * needs no new dependency to mint them.
 *
 * WHY the API version and headers are pinned: the endpoint is an app API
 * with no published contract; `v0a2158` plus the okhttp user agent is the
 * long-lived combination wgcf uses, and it was verified to accept the
 * MASQUE enrollment. A rejected registration surfaces as an error the admin
 * can retry, never as a half-written config.
 *
 * The registration is free and disposable: each call creates a new device,
 * and the returned credentials live only inside the outbound object.
 */

/** WHAT: the API surface device creation uses. */
export const WARP_API = "https://api.cloudflareclient.com/v0a2158/reg";
/** WHAT: the endpoint and HTTP version a WARP MASQUE tunnel speaks. */
export const WARP_MASQUE_SNI = "consumer-masque.cloudflareclient.com";
export const WARP_MASQUE_PORT = 443;
/**
 * WHAT: the oldest Xray that understands `masqueSettings.warp`.
 *
 * WHY pinned to a version: a node on an older core fails `xray -test` on the
 * rendered config, and the preset route warns before the operator saves one.
 */
export const WARP_MASQUE_MIN_XRAY = "26.10.21";
/** WHAT: the edge families a WARP outbound can dial. */
export type WarpEdge = "ipv6" | "ipv4";

/** WHAT: resolvers used inside the tunnel; WARP routes 1.1.1.1 natively. */
const WARP_RESOLVERS = [
  "1.1.1.1",
  "1.0.0.1",
  "2606:4700:4700::1111",
  "2606:4700:4700::1001",
];

/** WHAT: the device the registration call created. */
export type WarpDevice = { id: string; token: string };

/** WHAT: the tunnel facts an enrolled device reports. */
export type WarpEnrollment = {
  /** The WARP edge's P-256 public key (PEM or base64 SPKI), pinned by Xray. */
  peer_public_key: string;
  /** The edge hosts the registration offered, per family. */
  endpoints: { v4: string | null; v6: string | null };
  /** The addresses WARP assigned to the device, as /32 and /128. */
  addresses: [string, string];
};

/** WHAT: an enrollment plus the private half of the enrolled key. */
export type WarpMasque = WarpEnrollment & {
  /** Base64 PKCS #8 P-256 private key; Cloudflare sees only its public half. */
  private_key: string;
};

/** WHAT: the registration response, as far as this module reads it. */
type RegResponse = { id?: unknown; token?: unknown };

/** WHAT: the enrollment response, as far as this module reads it. */
type EnrollResponse = {
  config?: {
    peers?: unknown;
    interface?: unknown;
  };
};

/** WHAT: encode bytes as standard base64 (the API's key encoding). */
export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * WHAT: a throwaway 32-byte key for the registration call.
 *
 * WHY any value works: the endpoint only requires a well-formed Curve25519
 * public key to create the account, and the MASQUE enrollment replaces it
 * before the tunnel exists. Clamping and a derived public key would only
 * pretend the key still matters.
 */
function registrationKey(): string {
  return base64Encode(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * WHAT: a fresh P-256 key pair, base64 PKCS #8 private and SPKI public.
 *
 * WHY WebCrypto and not a curve library: the Worker platform exports
 * exactly the DER shapes Xray parses, and adding a dependency for two
 * `crypto.subtle` calls would be the only reason to have one.
 */
export async function generateP256KeyPair(): Promise<{
  private_key: string;
  public_key: string;
}> {
  const algorithm: SubtleCryptoGenerateKeyAlgorithm = {
    name: "ECDSA",
    namedCurve: "P-256",
  };
  const pair = (await crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const [pkcs8, spki] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", pair.privateKey) as Promise<ArrayBuffer>,
    crypto.subtle.exportKey("spki", pair.publicKey) as Promise<ArrayBuffer>,
  ]);
  return {
    private_key: base64Encode(new Uint8Array(pkcs8)),
    public_key: base64Encode(new Uint8Array(spki)),
  };
}

/**
 * WHAT: pull and validate one string field out of a nested object.
 *
 * WHY a path string: the response nests device facts three levels deep and
 * one missing level must produce the field name, not a TypeError.
 */
function stringField(source: unknown, path: string): string {
  let cursor: unknown = source;
  for (const part of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) {
      throw new Error(`warp: response is missing ${path}`);
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (typeof cursor !== "string" || !cursor) {
    throw new Error(`warp: response is missing ${path}`);
  }
  return cursor;
}

/**
 * WHAT: the host part of an endpoint value (`host:port`, `[v6]:port`, host).
 *
 * WHY strip it: the API reports the peer port as 0 ("any") and the tunnel
 * always dials the MASQUE port, so only the host is meaningful.
 */
export function endpointHost(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    return end > 1 ? text.slice(1, end) : null;
  }
  const colon = text.lastIndexOf(":");
  return colon > 0 ? text.slice(0, colon) : text;
}

/**
 * WHAT: return true when an Xray version string supports WARP over MASQUE.
 *
 * WHY not a string comparison: `26.9.30` must sort below `26.10.21`. A
 * missing or unparsable version (a node that never reported one) is false,
 * which is what makes the preset warning fire instead of staying silent.
 */
export function supportsWarpMasque(
  xrayVersion: string | null | undefined,
  minimum: string = WARP_MASQUE_MIN_XRAY,
): boolean {
  const parse = (value: string): number[] | null => {
    const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const current = parse(xrayVersion ?? "");
  const required = parse(minimum);
  if (current === null || required === null) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (current[index]! !== required[index]!) {
      return current[index]! > required[index]!;
    }
  }
  return true;
}

/**
 * WHAT: create one free WARP device and return its registration credentials.
 *
 * WHY `fetcher` is a parameter: this is a network call, so unit tests inject
 * a stub and prove the request shape without touching Cloudflare.
 */
export async function registerWarp(
  fetcher: typeof fetch,
  now: Date,
): Promise<WarpDevice> {
  const response = await fetcher(WARP_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "okhttp/3.12.1",
      "CF-Client-Version": "a-6.10-2158",
    },
    body: JSON.stringify({
      key: registrationKey(),
      install_id: "",
      fcm_token: "",
      tos: now.toISOString(),
      model: "PC",
      locale: "en_US",
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`warp: registration answered HTTP ${response.status} ${detail}`);
  }
  const body = (await response.json()) as RegResponse;
  return {
    id: stringField(body, "id"),
    token: stringField(body, "token"),
  };
}

/**
 * WHAT: switch one device to MASQUE and return the tunnel parameters.
 *
 * WHY the caller passes its own key pair: the preset mints it and would
 * otherwise keep a copy that only this function needs, and a test can pin
 * the exact SPKI it sends.
 */
export async function enrollMasque(
  fetcher: typeof fetch,
  device: WarpDevice,
  keys: { public_key: string },
): Promise<WarpEnrollment> {
  const response = await fetcher(`${WARP_API}/${device.id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "okhttp/3.12.1",
      "CF-Client-Version": "a-6.10-2158",
      Authorization: `Bearer ${device.token}`,
    },
    body: JSON.stringify({
      key: keys.public_key,
      key_type: "secp256r1",
      tunnel_type: "masque",
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`warp: enrollment answered HTTP ${response.status} ${detail}`);
  }
  const body = (await response.json()) as EnrollResponse;
  const config = body.config;
  if (typeof config !== "object" || config === null) {
    throw new Error("warp: enrollment response has no config");
  }
  const peers = config.peers;
  if (!Array.isArray(peers) || peers.length === 0 || typeof peers[0] !== "object") {
    throw new Error("warp: enrollment response has no peer");
  }
  const peer = peers[0] as Record<string, unknown>;
  const endpointField = peer["endpoint"];
  const peerEndpoint =
    typeof endpointField === "object" && endpointField !== null
      ? (endpointField as Record<string, unknown>)
      : {};
  // WHAT: both hosts the registration offers. The port it reports is
  // meaningless (see endpointHost), so only the hosts survive; which family
  // to dial belongs to the outbound, not to the enrollment.
  const endpoints = {
    v4: endpointHost(peerEndpoint["v4"]),
    v6: endpointHost(peerEndpoint["v6"]),
  };
  if (endpoints.v4 === null && endpoints.v6 === null) {
    throw new Error("warp: enrollment response has no peer endpoint");
  }
  return {
    peer_public_key: stringField(peer, "public_key"),
    endpoints,
    // WHY both families regardless of the edge: only the dial path moves.
    // Dropping either address would take that family's source away and break
    // every destination it exits to.
    addresses: [
      `${stringField(config, "interface.addresses.v4")}/32`,
      `${stringField(config, "interface.addresses.v6")}/128`,
    ],
  };
}

/**
 * WHAT: register a device, switch it to MASQUE, and return the tunnel facts.
 *
 * WHY the private key comes back here and not from `enrollMasque`: the key
 * pair is minted once, used for the public half in the PATCH, and only the
 * private half survives into the outbound.
 */
export async function createWarpMasque(
  fetcher: typeof fetch,
  now: Date,
): Promise<WarpMasque> {
  const device = await registerWarp(fetcher, now);
  const keys = await generateP256KeyPair();
  const enrollment = await enrollMasque(fetcher, device, keys);
  return { ...enrollment, private_key: keys.private_key };}

/**
 * WHAT: the Xray `masque` outbound object for one WARP enrollment.
 *
 * WHY HTTP/3 only: the tunnel carries IP packets inside QUIC datagrams,
 * which is the shape the official client uses and the one that avoids
 * stacking IP packets inside a TCP stream. `alpn` is therefore `h3`.
 *
 * WHY serverName is the consumer edge name: Xray pins the edge certificate
 * to `warp.publicKey`, so the name is cosmetic — but using the real one
 * keeps the handshake indistinguishable from the official client's.
 *
 * WHY the edge is a parameter: the dial family and the interface's source
 * addresses are independent. A tunnel dialled over IPv4 still carries IPv6
 * packets, so selecting IPv4 narrows only the path to the edge, never the
 * destinations the exit can reach.
 */
export function warpMasqueOutbound(
  tag: string,
  registration: WarpMasque,
  edge: WarpEdge = "ipv6",
): Record<string, unknown> {
  // WHY IPv6 falls back to IPv4: a registration that omits the v6 host still
  // yields a working tunnel, which is the behavior before the choice existed.
  // IPv4 has no fallback: dialling the other family would contradict an
  // explicit choice, so the build fails instead.
  const endpoint =
    edge === "ipv4"
      ? registration.endpoints.v4
      : registration.endpoints.v6 ?? registration.endpoints.v4;
  if (endpoint === null) {
    throw new Error(`warp: the registration offers no ${edge} edge`);
  }
  return {
    tag,
    protocol: "masque",
    settings: {
      address: endpoint,
      port: WARP_MASQUE_PORT,
      remoteDNS: [...WARP_RESOLVERS],
    },
    streamSettings: {
      network: "masque",
      security: "tls",
      tlsSettings: {
        serverName: WARP_MASQUE_SNI,
        alpn: ["h3"],
      },
      masqueSettings: {
        warp: {
          privateKey: registration.private_key,
          publicKey: registration.peer_public_key,
          address: registration.addresses,
        },
      },
    },
  };
}
