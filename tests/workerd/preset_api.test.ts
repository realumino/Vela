/**
 * The preset API: catalog, merge, and the WARP registration route.
 *
 * WHY over HTTP: the SPA sends the editor's draft and receives the merged
 * document, so the request shape (base skeleton, per-node defaults, 404 for
 * an unknown preset) is the contract the config page relies on. The WARP
 * registration is answered by the test outbound mock with a canned device.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { planeJson, uid } from "../helpers";

/** WHAT: one preset build response. */
type PresetBuildOut = {
  config: Record<string, unknown>;
  warnings: string[];
};

/** WHAT: the preset catalog response. */
type PresetListOut = {
  base: Record<string, unknown>;
  presets: Array<{
    id: string;
    label: string;
    summary: string;
    fields: Array<{
      name: string;
      label: string;
      hint: string;
      choices?: Array<{ value: string; label: string }>;
    }>;
    defaults: Record<string, string>;
  }>;
};

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("the preset catalog", () => {
  let node: string;

  beforeEach(async () => {
    node = uid("n");
    const created = await planeJson("POST", "/api/admin/nodes", {
      id: node,
      label: "Node",
      address: "tokyo.example.org",
    });
    expect(created.status).toBe(201);
  });

  it("describes the presets and the base skeleton", async () => {
    const response = await planeJson("GET", `/api/admin/nodes/${node}/presets`);
    expect(response.status, await response.clone().text()).toBe(200);
    const catalog = await body<PresetListOut>(response);

    expect(catalog.base).toEqual({
      log: { loglevel: "warning" },
      inbounds: [],
      outbounds: [{ tag: "BLOCK", protocol: "blackhole" }],
      routing: { rules: [] },
    });
    expect(catalog.presets.map((preset) => preset.id)).toEqual([
      "reality",
      "warp",
      "geo_block",
    ]);
    const reality = catalog.presets[0];
    expect(reality.defaults["domain"]).toBe("tokyo.example.org");
    expect(reality.fields.map((field) => field.name)).toEqual([
      "tag",
      "domain",
      "socket",
      "shortId",
      "flow",
    ]);
    const warp = catalog.presets[1];
    expect(warp.fields.map((field) => field.name)).toEqual(["tag", "edge"]);
    expect(warp.defaults["edge"]).toBe("ipv6");
    expect(warp.fields[1].choices).toEqual([
      { value: "ipv6", label: "IPv6" },
      { value: "ipv4", label: "IPv4" },
    ]);

    // WHY: an example value in a field is a value the operator can mistake
    // for a default; every field explains its rule in `hint` instead.
    for (const preset of catalog.presets) {
      for (const field of preset.fields) {
        expect(field).not.toHaveProperty("placeholder");
        expect(field.hint.length).toBeGreaterThan(0);
      }
      expect(Object.keys(preset.defaults).length).toBeGreaterThan(0);
    }
  });

  it("404s the catalog for an unknown node", async () => {
    const response = await planeJson("GET", "/api/admin/nodes/ghost/presets");
    expect(response.status).toBe(404);
  });

  it("builds a REALITY inbound onto the base skeleton", async () => {
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/presets/reality`,
      {
        config: null,
        options: {
          tag: "reality",
          domain: "tokyo.example.org",
          socket: "/dev/shm/lessv-decoy.sock",
          shortId: "1234abcd",
          flow: "xtls-rprx-vision",
        },
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await body<PresetBuildOut>(response);

    expect(result.warnings).toEqual([]);
    expect(result.config["outbounds"]).toEqual([
      { tag: "BLOCK", protocol: "blackhole" },
    ]);
    const inbounds = result.config["inbounds"] as Array<Record<string, unknown>>;
    expect(inbounds).toHaveLength(1);
    expect(inbounds[0]).toMatchObject({
      tag: "reality",
      port: 443,
      streamSettings: {
        realitySettings: { serverNames: ["tokyo.example.org"], privateKey: "" },
      },
    });
  });

  it("replaces the same inbound tag instead of appending a duplicate", async () => {
    const first = await body<PresetBuildOut>(
      await planeJson("POST", `/api/admin/nodes/${node}/presets/reality`, {
        config: null,
        options: { tag: "reality", domain: "one.example.org", shortId: "aa" },
      }),
    );
    const second = await body<PresetBuildOut>(
      await planeJson("POST", `/api/admin/nodes/${node}/presets/reality`, {
        config: first.config,
        options: { tag: "reality", domain: "two.example.org", shortId: "bb" },
      }),
    );
    const inbounds = second.config["inbounds"] as Array<Record<string, unknown>>;
    expect(inbounds).toHaveLength(1);
    expect(inbounds[0]["streamSettings"]).toMatchObject({
      realitySettings: { serverNames: ["two.example.org"], shortIds: ["bb"] },
    });
  });

  it("adds geo-block rules next to the document's own rules", async () => {
    const authored = {
      inbounds: [],
      outbounds: [
        { tag: "BLOCK", protocol: "blackhole" },
        { tag: "direct", protocol: "freedom" },
      ],
      routing: { rules: [{ type: "field", domain: ["geosite:cn"], outboundTag: "direct" }] },
    };
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/presets/geo_block`,
      {
        config: authored,
        options: { countries: "cn", categories: "category-ads-all", target: "BLOCK" },
      },
    );
    expect(response.status).toBe(200);
    const result = await body<PresetBuildOut>(response);
    const rules = (result.config["routing"] as Record<string, unknown>)[
      "rules"
    ] as unknown[];
    expect(rules).toHaveLength(3);
    expect(rules[1]).toEqual({
      type: "field",
      ip: ["geoip:cn"],
      outboundTag: "BLOCK",
    });
    expect(rules[2]).toEqual({
      type: "field",
      domain: ["geosite:category-ads-all"],
      outboundTag: "BLOCK",
    });
    expect(result.warnings).toEqual([]);
  });

  /** WHAT: mint one node token and report a heartbeat with a core version. */
  async function reportXrayVersion(version: string): Promise<void> {
    const token = (
      await body<{ token: string }>(
        await planeJson("POST", `/api/admin/nodes/${node}/token`),
      )
    ).token;
    const heartbeat = await planeJson(
      "POST",
      "/api/node/heartbeat",
      { protocol: 3, xray_version: version },
      { Authorization: `Bearer ${token}`, "X-Vela-Server": node },
    );
    expect(heartbeat.status).toBe(200);
  }

  it("registers a WARP device and returns a masque outbound", async () => {
    await reportXrayVersion("26.11.9");
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/presets/warp`,
      { config: null, options: { tag: "warp" } },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await body<PresetBuildOut>(response);
    expect(result.warnings).toEqual([]);
    const outbounds = result.config["outbounds"] as Array<Record<string, unknown>>;
    expect(outbounds.map((entry) => entry["tag"])).toEqual(["BLOCK", "warp"]);
    const warp = outbounds[1] as {
      protocol: string;
      settings: Record<string, unknown>;
      streamSettings: Record<string, unknown>;
    };
    expect(warp.protocol).toBe("masque");
    expect(warp.settings["address"]).toBe("2606:4700:103::2");
    expect(warp.settings["port"]).toBe(443);
    expect(warp.streamSettings).toMatchObject({
      network: "masque",
      security: "tls",
      tlsSettings: {
        serverName: "consumer-masque.cloudflareclient.com",
        alpn: ["h3"],
      },
      masqueSettings: {
        warp: {
          publicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEIw==",
          address: [
            "172.16.0.2/32",
            "2606:4700:110:8a78:72d9:6e7f:da52:294f/128",
          ],
        },
      },
    });
  });

  it("dials the IPv4 WARP edge when the preset asks for it", async () => {
    await reportXrayVersion("26.11.9");
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/presets/warp`,
      { config: null, options: { tag: "warp", edge: "ipv4" } },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await body<PresetBuildOut>(response);
    expect(result.warnings).toEqual([]);
    const warp = (result.config["outbounds"] as Array<Record<string, unknown>>)[1] as {
      settings: Record<string, unknown>;
      streamSettings: Record<string, unknown>;
    };
    expect(warp.settings["address"]).toBe("162.159.198.2");
    expect(warp.streamSettings).toMatchObject({
      masqueSettings: {
        warp: {
          address: [
            "172.16.0.2/32",
            "2606:4700:110:8a78:72d9:6e7f:da52:294f/128",
          ],
        },
      },
    });
  });

  it("warns about an unknown WARP edge and dials IPv6", async () => {
    await reportXrayVersion("26.11.9");
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/presets/warp`,
      { config: null, options: { tag: "warp", edge: "bogus" } },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await body<PresetBuildOut>(response);
    expect(result.warnings).toEqual(["unknown WARP edge 'bogus'; using ipv6"]);
    const warp = (result.config["outbounds"] as Array<Record<string, unknown>>)[1] as {
      settings: Record<string, unknown>;
    };
    expect(warp.settings["address"]).toBe("2606:4700:103::2");
  });

  it("warns when the node core predates MASQUE WARP support", async () => {
    await reportXrayVersion("26.1.1");
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/presets/warp`,
      { config: null, options: { tag: "warp" } },
    );
    const result = await body<PresetBuildOut>(response);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/needs 26\.10\.21 or newer/);
  });

  it("stays silent about the core when the node never reported one", async () => {
    // WHY: a server may stop reporting `xray_version`; unknown is not the same
    // as too old, and a permanent warning would teach the operator to ignore it.
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/presets/warp`,
      { config: null, options: { tag: "warp" } },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await body<PresetBuildOut>(response);
    expect(result.warnings).toEqual([]);
  });

  it("404s an unknown preset and 422s a non-object document", async () => {
    expect(
      (
        await planeJson("POST", `/api/admin/nodes/${node}/presets/nope`, {
          config: null,
          options: {},
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await planeJson("POST", `/api/admin/nodes/${node}/presets/reality`, {
          config: [1, 2],
          options: {},
        })
      ).status,
    ).toBe(422);
  });
});
