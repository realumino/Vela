/**
 * The JSON shapes the admin API returns and accepts.
 *
 * WHY a hand-written mirror of src/models.py: the SPA and the Worker are
 * separate builds in separate languages, so the contract is duplicated by
 * necessity. Keeping every shape in one file makes that duplication
 * reviewable, and the API is frozen for M5, so the mirror is stable.
 */

/** GET /api/admin/nodes — one node as the list/header sees it. */
export interface NodeOut {
  id: string;
  label: string;
  /** The admin-set share-link domain (optional; blank until set). */
  address: string;
  /** Which ACME environment's current certificates this node receives. */
  cert_environment: "production" | "staging";
  created_at: number;
  has_config: boolean;
}

/** POST /api/admin/nodes/{id}/token — the one-time mint response. */
export interface NodeTokenOut {
  node_id: string;
  token: string;
  cloud_init: string;
  image: string;
  binary: string;
  created_at: number;
}

/** One admin key in GET /api/admin/keys — never the token, never the hash. */
export interface AdminKeyOut {
  id: string;
  label: string;
  created_at: number;
  disabled_at: number | null;
}

/** POST /api/admin/keys — the plaintext rides only in this response. */
export interface AdminKeyCreatedOut {
  id: string;
  label: string;
  created_at: number;
  token: string;
}

/** GET /api/admin/nodes/{id}/config/runtime — the live render. */
export interface NodeRuntimeOut {
  config: Record<string, unknown>;
  hash: string;
  warnings: string[];
}

/** One maintenance action the plane asked this node to perform. */
export interface NodeActionOut {
  action: "update_xray" | "update_geodata";
  state: "pending" | "ok" | "failed";
  target: string | null;
  message: string | null;
  requested_at: number;
  finished_at: number | null;
}

/** GET /api/admin/nodes/{id}/sync — drift plus liveness at a glance. */
export interface NodeSyncOut {
  node_id: string;
  state: "pending" | "active";
  desired_hash: string | null;
  applied_hash: string | null;
  in_sync: boolean;
  last_seen: number | null;
  health: string | null;
  agent_version: string | null;
  xray_version: string | null;
  /** The XTLS/Xray-rules-dat release the node installed. */
  geodata_version: string | null;
  last_error: string | null;
  warnings: string[];
  actions: NodeActionOut[];
  nginx_ok: number | null;
  nginx_error: string | null;
  cert_synced_at: number | null;
  certs: Array<{ domain: string; not_after: string; profile: string }>;
}

/** One node's access section in a user response (server-generated uuids). */
export interface AccessOut {
  allowed_inbounds: string[];
  allowed_outbounds: string[];
  uuids: Record<string, string>;
}
/** One node's access section in a user write payload (no uuids). */
export interface AccessIn {
  allowed_inbounds: string[];
  allowed_outbounds: string[];
}

/** GET /api/admin/users — one user with per-node access. */
export interface UserOut {
  username: string;
  status: string;
  expire: number | null;
  note: string | null;
  /** The subscription capability token, plaintext. */
  sub_token: string | null;
  sub_token_created_at: number | null;
  created_at: number;
  access: Record<string, AccessOut>;
}

/** POST /api/admin/users body. */
export interface UserCreateIn {
  username: string;
  status: string;
  expire: number | null;
  note: string | null;
  access: Record<string, AccessIn>;
}

/** PUT /api/admin/users/{username} body (all fields, access authoritative). */
export interface UserUpdateIn {
  status: string;
  expire: number | null;
  note: string | null;
  access: Record<string, AccessIn>;
}

/** One generated VLESS link, carrying its own node. */
export interface ShareLink {
  node: string;
  inbound: string;
  outbound: string;
  email: string;
  profile: string | null;
  label: string | null;
  uri: string;
}

/** GET /api/admin/users/{username}/links. */
export interface UserLinksOut {
  username: string;
  links: ShareLink[];
  warnings: string[];
}

/** POST /api/admin/users/{username}/sub-token — mint or rotate. */
export interface SubTokenOut {
  username: string;
  sub_token: string;
  created_at: number;
}

/** GET /api/admin/nodes/{id}/inbounds — one registered inbound. */
export interface InboundOut {
  id: string;
  tag: string;
  label: string;
  protocol: string;
  network: string;
  security: string;
}

/** What an outbound does; `block` is never assignable to a user. */
export type OutboundKind = "block" | "direct" | "proxy";

/** GET /api/admin/nodes/{id}/outbounds — one registered outbound. */
export interface OutboundOut {
  id: string;
  tag: string;
  label: string;
  protocol: string;
  kind: OutboundKind;
}

/** One row of GET /api/admin/nodes/{id}/reality (public key only). */
export interface RealityKey {
  inbound_id: string;
  tag: string;
  label: string;
  public_key: string | null;
  created_at: number | null;
}

/** GET/POST/PUT inbound links: one extra client-side view of an inbound. */
export interface InboundLinkOut {
  id: string;
  inbound_id: string;
  label: string;
  overrides: Record<string, string | number>;
  created_at: number;
}

/** POST/PUT inbound links body. */
export interface InboundLinkIn {
  id: string;
  inbound_id: string;
  label: string;
  overrides: Record<string, string | number>;
}

/** One option of a preset field the dialog renders as a select. */
export interface PresetFieldChoiceOut {
  value: string;
  label: string;
}

/** One input a preset dialog collects. */
export interface PresetFieldOut {
  name: string;
  label: string;
  hint: string;
  choices?: PresetFieldChoiceOut[];
}

/** One preset as the config page describes it. */
export interface PresetOut {
  id: "reality" | "warp" | "geo_block";
  label: string;
  summary: string;
  fields: PresetFieldOut[];
  defaults: Record<string, string>;
}

/** GET /api/admin/nodes/{id}/presets. */
export interface PresetCatalogOut {
  base: Record<string, unknown>;
  presets: PresetOut[];
}

/** POST /api/admin/nodes/{id}/presets/{preset_id} — the merged document. */
export interface PresetBuildOut {
  config: Record<string, unknown>;
  warnings: string[];
}

/** GET /api/admin/status — the header's cheap composite snapshot. */
export interface StatusOut {
  node_count: number;
  user_count: number;
}

// --- Certificates (P1b) ------------------------------------------------------

/** GET /api/admin/zones — the zones the DNS token can read. */
export interface ZoneOut {
  id: string;
  name: string;
  status: string;
}

/** GET /api/admin/dns-credentials — the token itself never appears. */
export interface DnsCredentialOut {
  id: string;
  label: string;
  active: boolean;
  created_at: number;
  updated_at: number;
}

/** POST /api/admin/dns-credentials — stored verified; zones is the count. */
export interface DnsCredentialSavedOut {
  id: string;
  label: string;
  active: boolean;
  zones: number;
}

/** One current-certificate summary embedded in domain/node views. */
export interface CertificateSummaryOut {
  id: string;
  environment: "production" | "staging";
  serial: string;
  fingerprint_sha256: string;
  sans: string[];
  not_before: string;
  not_after: string;
  profile: string;
  purged_at: string | null;
  created_at: string;
}

/** GET/POST/PATCH /api/admin/cert-domains — one cert domain. */
export interface CertDomainOut {
  id: string;
  name: string;
  path: string;
  zone_id: string;
  include_wildcard: boolean;
  acme_profile: string;
  renew_before_days: number | null;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  production_certificate: CertificateSummaryOut | null;
  staging_certificate: CertificateSummaryOut | null;
}

/** POST /api/admin/cert-domains body. */
export interface CertDomainCreateIn {
  name: string;
  zone_id?: string;
  include_wildcard?: boolean;
  renew_before_days?: number | null;
}

/** PATCH /api/admin/cert-domains/{id} body (null = reset/unchanged). */
export interface CertDomainUpdateIn {
  include_wildcard?: boolean | null;
  renew_before_days?: number | null;
  status?: string | null;
}

/** One recorded step of an issue run. */
export interface CertRunStep {
  phase: string;
  at: string;
}

/** GET /api/admin/cert-runs/{id} and the domain runs list. */
export interface CertRunOut {
  id: string;
  domain_id: string;
  domain_name: string;
  environment: "production" | "staging";
  trigger: string;
  status: string;
  phase: string | null;
  error: string | null;
  workflow_id: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  steps: CertRunStep[];
}

/** GET /api/admin/cert-domains/{id}/certs and /api/admin/certificates/{id}. */
export interface CertificateOut {
  id: string;
  domain_id: string;
  domain_name: string;
  environment: "production" | "staging";
  serial: string;
  fingerprint_sha256: string;
  sans: string[];
  not_before: string;
  not_after: string;
  profile: string;
  is_current: boolean;
  purged_at: string | null;
  created_at: string;
}

/** One domain in a node's assignment view. */
export interface NodeCertDomainOut {
  id: string;
  name: string;
  status: string;
  assigned: boolean;
  current_certificate: CertificateSummaryOut | null;
}

/** GET/PUT /api/admin/nodes/{id}/cert-domains. */
export interface NodeCertDomainsOut {
  node_id: string;
  /** The environment whose current certificate this node is served. */
  cert_environment: "production" | "staging";
  domains: NodeCertDomainOut[];
  nginx_ok: number | null;
  nginx_error: string | null;
  cert_synced_at: number | null;
}

/** One assigned certificate summary for a node. */
export interface NodeCertSummary {
  domain: string;
  path: string;
  sans: string[];
  serial: string;
  fingerprint_sha256: string;
  not_before: string;
  not_after: string;
  profile: string;
}

/** GET /api/admin/nodes/{id}/certs. */
export interface NodeCertsOut {
  node_id: string;
  /** The environment these summaries describe. */
  cert_environment: "production" | "staging";
  nginx_ok: number | null;
  nginx_error: string | null;
  cert_synced_at: number | null;
  certs: NodeCertSummary[];
}

/** One (inbound view, exit) combination as the naming endpoint returns it. */
export interface NamingCombination {
  inbound_id: string;
  inbound_tag: string;
  inbound_label: string;
  /** Empty for the inbound's default view. */
  link_id: string;
  link_label: string | null;
  outbound_id: string;
  outbound_tag: string;
  outbound_label: string;
  /** The name a client would see right now. */
  name: string;
  /** The stored literal name, or null when the template produces it. */
  override: string | null;
}

/** One node's combinations. */
export interface NamingNode {
  id: string;
  label: string;
  has_config: boolean;
  combinations: NamingCombination[];
}

/** GET /api/admin/naming and the response of its two writes. */
export interface NamingOut {
  templates: {
    link_name_template: string;
    subscription_title_template: string;
  };
  defaults: {
    link_name_template: string;
    subscription_title_template: string;
  };
  fields: {
    link_name: string[];
    subscription_title: string[];
  };
  nodes: NamingNode[];
}
