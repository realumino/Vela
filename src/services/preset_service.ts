/**
 * Presets: config fragments the plane merges into an authored document.
 *
 * WHY fragments and not whole configs: a preset answers one question ("add a
 * REALITY inbound", "route geo-blocked destinations to BLOCK", "add a WARP
 * exit") and must compose with everything else in the operator's document.
 * The merge is deterministic: array items are keyed by `tag` (replace in
 * place, append when new), other arrays are appended unless an identical
 * element is already present, and objects are merged recursively.
 *
 * WHY the merge runs here and saves nothing: the admin reviews the merged
 * document in the editor and stores it with the ordinary config PUT. A
 * preset can therefore never silently change a live node.
 *
 * WHY a base config: an empty document cannot render (Xray needs a first
 * outbound), and every preset starts from a skeleton whose only route is the
 * panel-owned BLOCK blackhole.
 */

import { canonicalJson } from "../core/python_json";
import { createWarpMasque, warpMasqueOutbound } from "./warp_service";

/** WHAT: a JSON object carrying config data. */
type Dict = Record<string, unknown>;

/**
 * WHAT: the decoy socket a self-steal REALITY inbound targets.
 *
 * WHY the name keeps its prefix: the path is a wire constant — deployed
 * agents create their decoy socket here and the plane renders it as REALITY
 * `dest`. Renaming it is a protocol change, not a rebrand.
 */
export const DECOY_SOCKET = "/dev/shm/lessv-decoy.sock";

/**
 * WHAT: the routing strategy an ip-matching fragment needs.
 *
 * WHY IPOnDemand and not IPIfNonMatch: the plane always appends a per-user
 * rule (`user: regexp:.*@<node>-<exit>`) after the operator's rules, and that
 * rule matches every connection. Xray's IPIfNonMatch resolves a domain only
 * when NO rule matched, so the later catch-all wins before any resolution
 * happens and the ip rule never sees a domain destination. IPOnDemand
 * resolves as soon as the ip rule is evaluated, which is what makes the
 * fragment effective (verified on a live node: an IP literal was blocked,
 * the same address behind a hostname was not, under IPIfNonMatch).
 */
export const GEO_DOMAIN_STRATEGY = "IPOnDemand";

/** WHAT: the empty skeleton every new document starts from. */
export const BASE_CONFIG: Dict = {
  log: { loglevel: "warning" },
  inbounds: [],
  outbounds: [{ tag: "BLOCK", protocol: "blackhole" }],
  routing: { rules: [] },
};

/** WHAT: the presets this plane can build. */
export type PresetId = "reality" | "warp" | "geo_block";

/** WHAT: one option of a field the dialog renders as a select. */
export type PresetFieldChoice = { value: string; label: string };

/** WHAT: one input a preset dialog collects. */
export type PresetField = {
  name: string;
  label: string;
  hint: string;
  choices?: PresetFieldChoice[];
};

/** WHAT: one preset as the admin UI describes it. */
export type PresetDescriptor = {
  id: PresetId;
  label: string;
  summary: string;
  fields: PresetField[];
  defaults: Record<string, string>;
};

/** WHAT: return true only for a non-empty object (not an array). */
function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** WHAT: a fresh shortId (4 random bytes, even-length hex). */
export function randomShortId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * WHAT: the preset catalog, with defaults computed for one node.
 *
 * WHY defaults come from the server: the REALITY domain defaults to the
 * node's configured address and the shortId must be fresh per dialog, and
 * neither fact belongs in the SPA.
 */
export function presetDescriptors(nodeAddress: string): PresetDescriptor[] {
  return [
    {
      id: "reality",
      label: "REALITY inbound",
      summary:
        "Adds one self-steal VLESS + REALITY inbound on 443. Xray relays " +
        "handshakes to the decoy over its Unix socket, and the plane " +
        "generates the key pair on render.",
      fields: [
        {
          name: "tag",
          label: "Inbound tag",
          hint: "Replaces an inbound with the same tag; otherwise appended.",
        },
        {
          name: "domain",
          label: "REALITY domain",
          hint:
            "The name the inbound presents; it needs a matching certificate. " +
            "Defaults to the node's configured address.",
        },
        {
          name: "socket",
          label: "Decoy socket",
          hint: "The decoy listens on this local path; it never leaves the host.",
        },
        {
          name: "shortId",
          label: "shortId",
          hint:
            "Even-length hex; clients present it to prove they know it. " +
            "A fresh one is generated per dialog.",
        },
        {
          name: "flow",
          label: "Flow",
          hint: "Applied to every client the plane renders for this inbound.",
        },
      ],
      defaults: {
        tag: "reality",
        domain: nodeAddress,
        socket: DECOY_SOCKET,
        shortId: randomShortId(),
        flow: "xtls-rprx-vision",
      },
    },
    {
      id: "warp",
      label: "WARP outbound",
      summary:
        "Registers a free Cloudflare WARP device, switches it to MASQUE " +
        "(CONNECT-IP over HTTP/3) and adds it as a masque outbound. Each " +
        "build creates a new device; the edge family selects the dial path.",
      fields: [
        {
          name: "tag",
          label: "Outbound tag",
          hint: "Replaces an outbound with the same tag; otherwise appended.",
        },
        {
          name: "edge",
          label: "Edge address family",
          hint:
            "Which family the tunnel dials. The interface keeps both assigned " +
            "addresses, so IPv4 and IPv6 destinations both exit either way. " +
            "IPv6 falls back to IPv4 only when the registration offers no " +
            "IPv6 edge; choose IPv4 on a node without working IPv6 egress.",
          choices: [
            { value: "ipv6", label: "IPv6" },
            { value: "ipv4", label: "IPv4" },
          ],
        },
      ],
      defaults: { tag: "warp", edge: "ipv6" },
    },
    {
      id: "geo_block",
      label: "Block destinations by geodata",
      summary:
        "Appends routing rules that send matching destinations to the chosen " +
        "outbound (BLOCK by default) and sets routing.domainStrategy to " +
        "IPOnDemand so ip rules also see hostname destinations. Needs " +
        "geoip.dat/geosite.dat, which the node server installs and refreshes.",
      fields: [
        {
          name: "countries",
          label: "Country IP sets",
          hint:
            "Two-letter country codes, comma-separated; " +
            "each emits a geoip:<code> matcher.",
        },
        {
          name: "categories",
          label: "Domain categories",
          hint:
            "geosite categories, comma-separated; " +
            "each emits a geosite:<category> matcher.",
        },
        {
          name: "target",
          label: "Target outbound tag",
          hint: "A tag already present in the document, or BLOCK.",
        },
      ],
      defaults: { countries: "", categories: "", target: "BLOCK" },
    },
  ];
}

/** WHAT: a non-empty trimmed option, or the fallback. */
function option(
  options: Record<string, string>,
  name: string,
  fallback: string,
): string {
  const value = options[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * WHAT: the REALITY inbound fragment.
 *
 * WHY `privateKey` stays empty: the plane owns REALITY keys per inbound
 * (`ensureKeys` at render), so the preset only has to guarantee the
 * structure; a pasted key would be overwritten and must not look meaningful.
 */
export function realityInboundFragment(
  options: Record<string, string>,
): [Dict, string[]] {
  const warnings: string[] = [];
  const domain = option(options, "domain", "");
  if (!domain) {
    warnings.push("domain is empty — REALITY needs a domain and a certificate");
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain)) {
    warnings.push(
      `${domain} is an IP address — self-steal needs a domain plus a certificate`,
    );
  }
  const socket = option(options, "socket", DECOY_SOCKET);
  if (!socket.startsWith("/")) {
    warnings.push(`nginx socket '${socket}' must be an absolute path`);
  } else if (socket.length > 100) {
    warnings.push(`nginx socket path is too long (${socket.length} > 100)`);
  }
  const shortId = option(options, "shortId", randomShortId());
  if (!/^[0-9a-f]*$/.test(shortId) || shortId.length % 2 !== 0) {
    warnings.push(`shortId '${shortId}' must be even-length hex`);
  }
  const tag = option(options, "tag", "reality");
  const flow = option(options, "flow", "xtls-rprx-vision");
  return [
    {
      tag,
      listen: "0.0.0.0",
      port: 443,
      protocol: "vless",
      settings: { clients: [], decryption: "none", flow },
      streamSettings: {
        network: "raw",
        security: "reality",
        realitySettings: {
          dest: socket,
          serverNames: domain ? [domain] : [],
          privateKey: "",
          shortIds: [shortId],
          settings: { fingerprint: "chrome", spiderX: "/" },
        },
      },
    },
    warnings,
  ];
}

/** WHAT: split a comma/space separated option into validated tokens. */
export function splitTokens(value: string, pattern: RegExp): string[] {
  return value
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token !== "" && pattern.test(token));
}

/**
 * WHAT: routing rules that send geo-matched destinations to one outbound.
 *
 * WHY two rules when both matchers are given: Xray ANDs the matchers inside
 * one rule, so `ip` + `domain` in a single rule would match only destinations
 * that are both a listed IP and a listed domain. Two rules express "either".
 */
export function geoBlockRules(options: Record<string, string>): [Dict[], string[]] {
  const warnings: string[] = [];
  const countries = splitTokens(
    options["countries"] ?? "",
    /^[A-Za-z0-9-]{1,16}$/,
  );
  const categories = splitTokens(
    options["categories"] ?? "",
    /^[A-Za-z0-9!._@-]{1,64}$/,
  );
  const target = option(options, "target", "BLOCK");
  const rules: Dict[] = [];
  if (countries.length > 0) {
    rules.push({
      type: "field",
      ip: countries.map((code) => `geoip:${code.toLowerCase()}`),
      outboundTag: target,
    });
  }
  if (categories.length > 0) {
    rules.push({
      type: "field",
      domain: categories.map((name) => `geosite:${name}`),
      outboundTag: target,
    });
  }
  if (rules.length === 0) {
    warnings.push("no valid countries or categories given; nothing was added");
  }
  return [rules, warnings];
}

/**
 * WHAT: append `source` into `target` with the preset merge rules.
 *
 * WHY tag is the array key: inbounds and outbounds are identified by tag
 * everywhere in the system, so merging by tag is what makes a preset
 * idempotent — building the REALITY preset twice replaces its inbound
 * instead of adding a duplicate tag the registry would reject.
 *
 * WHY scalar arrays replace instead of appending: they are attributes of
 * the item that owns them (`serverNames`, `shortIds`, `alpn`). Rebuilding a
 * preset must not accumulate last build's values — appending would produce
 * an inbound with two REALITY names and two short ids.
 */
function mergeValue(left: unknown, right: unknown): unknown {
  if (Array.isArray(left) && Array.isArray(right)) {
    const objects = right.every((item) => isDict(item));
    return objects ? mergeArrays(left, right) : right;
  }
  if (isDict(left) && isDict(right)) {
    const merged: Dict = { ...left };
    for (const [key, value] of Object.entries(right)) {
      merged[key] = key in merged ? mergeValue(merged[key], value) : value;
    }
    return merged;
  }
  return right;
}

/** WHAT: merge two arrays (tag replacement, then deduplicated append). */
export function mergeArrays(left: unknown[], right: unknown[]): unknown[] {
  const result = [...left];
  for (const item of right) {
    const tag = isDict(item) && typeof item["tag"] === "string" ? item["tag"] : null;
    if (tag !== null) {
      const index = result.findIndex(
        (existing) => isDict(existing) && existing["tag"] === tag,
      );
      if (index >= 0) {
        result[index] = mergeValue(result[index], item);
        continue;
      }
    } else if (result.some((existing) => canonicalJson(existing) === canonicalJson(item))) {
      continue;
    }
    result.push(item);
  }
  return result;
}

/** WHAT: merge one fragment into a document, without mutating either. */
export function mergeFragment(config: Dict, fragment: Dict): Dict {
  const merged: Dict = structuredClone(config);
  for (const [key, value] of Object.entries(fragment)) {
    merged[key] = key in merged ? mergeValue(merged[key], value) : value;
  }
  return merged;
}

/** WHAT: outbound tags declared by a document, for target validation. */
function outboundTags(config: Dict): string[] {
  const outbounds = config["outbounds"];
  if (!Array.isArray(outbounds)) {
    return [];
  }
  return outbounds
    .filter((entry): entry is Dict => isDict(entry))
    .map((entry) => entry["tag"])
    .filter((tag): tag is string => typeof tag === "string");
}

/**
 * WHAT: build one preset and merge it into the document.
 *
 * WHY `config === null` means the base skeleton: an empty editor has
 * nothing to merge into, and the base is the only document whose first
 * outbound is the BLOCK fallback the renderer guarantees.
 */
export async function buildPreset(
  id: PresetId,
  config: Dict | null,
  options: Record<string, string>,
  fetcher: typeof fetch,
  now: Date,
): Promise<[Dict, string[]]> {
  const document = config === null ? structuredClone(BASE_CONFIG) : config;
  if (id === "reality") {
    const [inbound, warnings] = realityInboundFragment(options);
    return [mergeFragment(document, { inbounds: [inbound] }), warnings];
  }
  if (id === "warp") {
    const warnings: string[] = [];
    const requested = option(options, "edge", "ipv6");
    if (requested !== "ipv4" && requested !== "ipv6") {
      warnings.push(`unknown WARP edge '${requested}'; using ipv6`);
    }
    const registration = await createWarpMasque(fetcher, now);
    const outbound = warpMasqueOutbound(
      option(options, "tag", "warp"),
      registration,
      requested === "ipv4" ? "ipv4" : "ipv6",
    );
    return [mergeFragment(document, { outbounds: [outbound] }), warnings];
  }
  const [rules, warnings] = geoBlockRules(options);
  const merged = mergeFragment(document, { routing: { rules } });
  const routing = (merged["routing"] ?? {}) as Dict;
  if (rules.some((rule) => Array.isArray(rule["ip"]))) {
    const strategy = routing["domainStrategy"];
    if (strategy === undefined) {
      routing["domainStrategy"] = GEO_DOMAIN_STRATEGY;
    } else if (strategy !== GEO_DOMAIN_STRATEGY) {
      warnings.push(
        `routing.domainStrategy is '${String(strategy)}'; the panel appends ` +
          `per-user rules, so ip rules only see hostname destinations under ` +
          `'${GEO_DOMAIN_STRATEGY}'`,
      );
    }
  }
  const target = option(options, "target", "BLOCK");
  const tags = outboundTags(merged);
  if (!tags.includes(target)) {
    warnings.push(
      `target outbound '${target}' is not declared by the document; ` +
        "the rule will fall through to the first outbound",
    );
  }
  return [merged, warnings];
}
