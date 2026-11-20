# Operations — certificates, nginx, server troubleshooting

Runbook for the product shape: Xray REALITY on 443 with self-steal over a
local Unix socket (`dest=/dev/shm/lessv-decoy.sock`), nginx serving the
decoy site with a Let's Encrypt certificate issued by the plane (DNS-01),
and nodes that pull their certificates from the plane.

## Topology

```
Internet ── :443 ──► Xray (REALITY, stream proxy)
                        │ realitySettings.dest = /dev/shm/lessv-decoy.sock
                        │ geoip:/geosite: ← /var/lib/vela/assets/*.dat
                        ▼
                     nginx (TLS, decoy site; Unix socket only, :80 = 301)
                        │ ssl_certificate = /etc/vela/certs/<path>/current/fullchain.pem
                        ▼
                     certificate files ← vela-server sync ← GET /api/node/certs
```

- 443 belongs to Xray. Never configure nginx to listen on 443.
- The stolen origin is local by construction: Xray and nginx share the host,
  so the handshake relay never leaves the kernel. The decoy listens on the
  socket only (no TCP listener) and :80 answers a 301.
- Certificates belong to nginx (the self-stealed origin); Xray has none.
- GeoIP/GeoSite data belongs to the server (`geodata_dir`, default
  `/var/lib/vela/assets`; Xray reads it through `XRAY_LOCATION_ASSET`).

## Presets and the base document (plane)

A preset is a fragment the plane merges into the document the admin holds;
it never saves. `GET /api/admin/nodes/{id}/presets` returns the base skeleton
and the catalog, `POST /api/admin/nodes/{id}/presets/{id}` with
`{"config": <document|null>, "options": {...}}` returns the merged document
for review, and the ordinary `PUT .../config` stores it when the admin
presses Save config.

- **Base config** — the skeleton a new node starts from:
  `inbounds: []`, `outbounds: [{tag: "BLOCK", protocol: "blackhole"}]`,
  `routing: {rules: []}`, `log: {loglevel: "warning"}`.
- **REALITY inbound** — one VLESS + REALITY inbound on 443,
  `network: raw`, `dest=/dev/shm/lessv-decoy.sock`, `serverNames=[domain]`,
  a fresh even-length-hex `shortId`, chrome fingerprint, vision flow.
  `privateKey` stays empty; the plane injects/stores keys per inbound at
  render time (`ensureKeys`), so the private key never appears in the
  frontend. Fields (tag, domain, socket, shortId, flow) default from the
  node's configured domain and the decoy socket.
  - `raw` is Xray's current name for the transport it used to call `tcp`;
    the renderer normalises an authored `tcp` too, so the node always applies
    the same spelling. A `tcpSettings` block keeps working next to it.
  - The socket path is a wire constant, not branding: the server creates its
    decoy socket there and the plane renders it as REALITY `dest`. Renaming
    it requires a server release and a protocol bump.
- **WARP outbound** — the plane registers a free Cloudflare WARP device
  (`POST https://api.cloudflareclient.com/v0a2158/reg`, the exchange wgcf
  performs), switches it to MASQUE with a P-256 key
  (`PATCH .../reg/{id}`, `key_type: secp256r1`, `tunnel_type: masque`), and
  returns a `masque` outbound (CONNECT-IP over HTTP/3, edge certificate
  pinned to the key the registration returns). Every build creates a new
  device. The node's Xray must be 26.10.21 or newer — the preset warns when
  a reported version is older, because the apply's config test would
  otherwise reject the outbound and roll back. A node that reports no version
  gets no warning: unknown is not the same as too old. `h3` only: the tunnel
  is QUIC, so a node whose uplink blocks UDP/443 cannot use it. **Edge
  address family** selects the dial path: IPv6 (the default) dials `v6` when
  the registration offers it and falls back to `v4`; IPv4 dials `v4` and
  fails the build if the registration offers none. Only the edge moves: the
  interface keeps both assigned address families, so an IPv4 edge still
  carries IPv6 destinations, and a node with no working IPv6 egress must
  select IPv4.
- **Geo block routing** — appends `geoip:<code>` and/or `geosite:<category>`
  rules that send matches to `BLOCK` (or another chosen tag). Two rules,
  because Xray ANDs the matchers inside one rule (`ip` + `domain` in one rule
  matches only destinations that satisfy both). When an `ip` rule is added,
  the preset sets `routing.domainStrategy: IPOnDemand` if the document has
  none: the plane appends a per-user rule that matches every connection, and
  Xray's `IPIfNonMatch` only resolves a hostname when **no** rule matched —
  the later per-user rule wins first, so an ip rule under `IPIfNonMatch`
  never sees a hostname destination. `IPOnDemand` resolves when the ip rule
  is evaluated. A document that already sets another strategy keeps it and
  the build warns. Needs the geodata files below.
- **Geo rules and real-world DNS** — `geoip:` is IP geolocation, and CDNs
  answer with regional edges: from an EU node `www.baidu.com` resolves to
  Baidu's Hong Kong range (103.235.46.0/24), not to a mainland IP, so an
  ip-only rule does not catch it even under `IPOnDemand`. Add the matching
  domain set (`categories: cn`, or `category-ru`) so the site is blocked by
  name. Both matchers are evaluated for the traffic a user sends as a
  hostname, which is the normal case through VLESS.

Merge rules: array items are keyed by `tag` (replace in place, append when
new), arrays of scalars replace, arrays of objects without a tag append
unless an identical element is already present, objects merge recursively.

`BLOCK` is the first outbound: it is the default route for unmatched
traffic, never assignable to a user, and excluded from routing allocation.
Every other outbound is rendered per node as `<node>-<tag>` (e.g.
`tokyo01-direct`). On the user authorization page select the exits the admin
added; every registered endpoint shows up on the node's Links tab, where its
name can be changed and extra link variants added.

## Geodata updates

The admin asks for a refresh on the node page (**Maintenance**); the plane
records a `node_actions` row and the node executes it on its next heartbeat,
then reports through `POST /api/node/action`. The weekly refresh is the only
automatic one. Xray itself is part of the node image and is updated by
replacing that image, not by the plane.

- **Geodata**: the node installs `geoip-full.dat` and `geosite.dat` from
  `XTLS/Xray-rules-dat` (latest release, SHA-256 sidecars verified,
  decompressed in-process) into `geodata_dir`, restarts Xray, and restores
  the previous pair if it does not stay up. The full GeoIP edition carries
  per-country sets; the lite edition would only know the regional
  whitelists.
  - First run: the node installs the data once regardless of its config.
  - Then: every 7 days while the live config references `geoip:`/`geosite:`,
    and on every admin request. A failed refresh is retried after 24 hours.

The action is visible in `GET /api/admin/nodes/{id}/sync` under `actions`
(`pending`/`ok`/`failed`, target, message, timestamps); a failure stays
visible until the admin requests the action again.

## Certificate lifecycle (plane)

1. **Admin UI → Certificates page** (`/certs`): pick a zone (from
   `GET /api/admin/zones`, which calls Cloudflare with the active DNS
   credential row), add a cert domain
   (`example.com`, `*.example.com`, or `vpn.example.com`). `include
   wildcard` adds a `*.<name>` SAN alongside `<name>`; a wildcard-only
   row starts with `*.` and issues just the wildcard.
2. **Test issue** (`POST /api/admin/cert-domains/:id/test-issue`) runs the full
   ACME flow against the Let's Encrypt **staging** directory and flips only
   the staging current pointer. Production stays untouched. Use it to
   validate DNS reachability before spending production rate limits.
3. **Issue** (`POST /api/admin/cert-domains/:id/issue`, body
   `{"confirm":"<exact domain>"}`) issues a **production** certificate.
   Rate limits apply (5 duplicates/week per name) — do not retry in a loop.
4. **Assignment** (node page → Certs tab, `PUT
   /api/admin/nodes/:id/cert-domains` with `{"domain_ids":[...]}`) decides
   which cert domains a node receives. Assignments act on the
   certificate **domain**, so renewals flow automatically.
5. **Environment** (node page → Certs tab, or `PUT /api/admin/nodes/:id`
   with `{"cert_environment":"staging"|"production"}`, default
   `production`) decides *which* current certificate of each assigned
   domain the node pulls: the production current pointer or the staging
   one. Same assignment, one pointer per environment — switching back and
   forth needs no re-assignment, and an update that does not name the field
   leaves it alone.
   - **Staging certificates are test-only.** They are signed by an
     untrusted root: browsers and normal clients reject them, so any test
     client must be told to trust the Let's Encrypt staging root
     explicitly. A staging node whose domain has no current staging
     certificate receives an empty manifest, not the production bytes, so
     the fail-safe is "serve nothing", never "serve the wrong
     environment".
   - Staging certificates are never renewed and are swept 7 days after
     issuance; after that the staging manifest for those domains is empty,
     so switch the node back to `production` when the test is over.
6. **Renewal**: the daily cron (`17 3 * * *` UTC) renews production
   certificates older than 1/3 of their lifetime (45 days → day 15), with a
   per-run jitter and idempotent date-range locking. Staging certificates
   are never renewed and are swept after 7 days.

Every issuance records an `issue_runs` row with phases
(`load` → `ensure-account` → `new-order-<n>` → `publish-txt-<n>` →
`wait-propagation-<n>` → `accept-challenges-<n>` → `await-authz-<n>` →
`key+csr` → `finalize+store` → `purge-previous` → `cleanup-txt` →
`finish-run`; `<n>` is the attempt number, an expired order reopens via
`order-expired-<n>`, and a failed run adds `cleanup-failed-artifacts`);
failures keep the raw Let's Encrypt error text in `error` — that is the
first place to look.

## Alpine cloud-init nodes

`POST /api/admin/nodes/{id}/token` returns a finished cloud-config beside the
token (`cloud_init` in the JSON, and in the token dialog). The operator copies
that document as the provider's user data — there is no template to edit and no
placeholder to fill: the node id, the control-plane origin, the token, the
image and the entrypoint are already in it. `?image=` and `?binary=` override
the image reference and entrypoint; both are validated, because they are
interpolated into the compose file and a shell command. The bootstrap pulls
exactly that reference and never resolves a tag on the operator's behalf. The
document targets Alpine/OpenRC images with cloud-init; any host with Docker can
run the same compose file by hand. There is no SSH and no Tailscale: the plane
is the management interface and the provider console is the rescue path.

**If docker does not start**, the host booted without a mounted cgroup
hierarchy; Alpine's docker init script needs the `cgroups` service and prints
`cannot start docker as cgroups would not start` when it is missing. The
document mounts cgroup2 itself before starting docker, so a first boot that
still fails there is worth reading in `/var/log/cloud-init-output.log`: the
bootstrap prints the cgroups and docker status and the last kernel messages
before it exits.

First boot sets:

- `/etc/sysctl.d/99-vela.conf` — BBR/fq, `fs.file-max`, socket backlog,
  keepalive. The bootstrap applies it once; the OpenRC `sysctl` service
  applies it on later boots. `ip_forward` is deliberately absent: the host
  terminates its own TLS and is not a router.
- `/etc/nftables.nft` — an inbound fallback that drops everything except TCP
  80/443, UDP 443 and ICMP echo. ICMP errors, IPv6 neighbour discovery, and
  DHCP client replies are allowed because TCP/IP and boot need them; no
  service listens on UDP 443 or answers the echo — the port is opened ahead of
  a listener so a future inbound does not need a new host document. There is
  deliberately no `forward` chain: the container's traffic is DNAT'd onto the
  Docker bridge and crosses that hook, which Docker manages in its own table —
  a second drop verdict there would race Docker's accepts and break the
  published ports. `22` is not open.
- `/etc/init.d/sshd` is replaced by a no-op. Stopping the service alone is not
  enough: cloud-init's `cc_ssh` calls `rc-service sshd restart`, and the
  default runlevel can start it after the bootstrap's cleanup. The no-op makes
  both paths inert; there is no SSH listener even if a runlevel link survives.
- Docker plus the compose plugin, started from the default runlevel. The
  compose file is written to `/etc/vela/compose.yaml`: one service, bridge
  networking, `ports: ["80:80", "443:443/tcp", "443:443/udp"]`, `restart:
  unless-stopped`, a 90-second stop grace period, a 1M `nofile` ulimit,
  `no-new-privileges`, and two named volumes (`vela-etc` on `/etc/vela`,
  `vela-state` on `/var/lib/vela`). The mount points are the image's
  contract; the volume names are the operator's.
- Enrollment runs once in a throwaway container with the token on stdin, so
  the token never lands in a shell history, an argument list, or the host's
  filesystem. `docker compose up -d` then starts the service, and the
  bootstrap fails loudly if the container is not running afterwards.
- `/etc/periodic/weekly/vela-upgrade` is the host's only maintenance: busybox
  crond (added to the default runlevel) runs `apk -U upgrade`, waits for the
  Docker daemon, and then `docker compose … up -d`, appending both to
  `/var/log/vela-upgrade.log` with a UTC timestamp. The bootstrap runs the same
  script once, **after** the service is confirmed running: an `apk` upgrade can
  restart dockerd, and doing that before the first start leaves nothing to
  bring the container back. It never reboots and never touches the image: the
  tag is the plane's decision and a rebuild is the recovery path.

Failure policy: a node that does not enroll is destroyed and rebuilt with a
new node id; user data is not retained for an in-place rebuild. Read
`/var/log/cloud-init-output.log` through the provider console when the first
boot fails.

Host maintenance is the weekly job above. Read `/var/log/vela-upgrade.log`
the same way — through the provider console (Lish or equivalent), because the
host has no SSH listener. A failed run is logged and nothing else: the job
neither reboots nor retries, and the service keeps running what it was
running. `docker compose ps` after a weekly run that upgraded `docker` itself
is the one observation worth making, since the job re-creates the container
right after the daemon restart.

The node token is in cloud-init user data (and in the root-only cloud-init
cache on the host). Providers generally cannot update user data in place, so
revocation is deleting the plane row, not rotating in place; the token's
blast radius is that node's rendered config and certificate private keys.
Keep rendered user data and inventories out of the tree.

## Server delivery

The server is a container image built and tested in
[LessV-Node](https://github.com/realumino/vela-server). It carries the
reconciler, Xray, nginx and the s6 supervisor; the host carries Docker, the
firewall and the published ports.

- **Upgrades replace the image.** Nothing on the host or in the plane updates
  Xray, nginx or the reconciler in place. Pin a tag in the compose file for a
  deliberate upgrade, or run `latest` and let a watchtower-style updater pull
  and recreate the container. Recreating a container resets any drift inside
  it — a hand-edited Xray binary or nginx config disappears, which is the
  point: the image is the truth and the plane is the configuration.
- **The two volumes are the node's identity.** `vela-etc` holds
  `/etc/vela`: the enrollment token file, the certificate tree and the nginx
  decoy configuration. Losing it means re-enrolling (the plane mints a new
  token) and re-fetching every certificate. `vela-state` holds
  `/var/lib/vela`: the state file, the live Xray config and the geodata
  files. Losing it costs one reconcile — the server re-fetches the config and
  the certificates and re-downloads geodata on its next poll.
- **One volume cannot be shared.** Two containers mounting the same
  `vela-etc` are two servers with one identity; the plane sees one row.
- `docker compose up -d` after editing the image tag is the upgrade;
  `docker restart` re-converges without re-enrolling because the applied hash
  still matches.

### On-disk layout inside the container

```
/etc/vela/certs/<domain path>/
├── <fingerprint sha256>/        # one directory per certificate version
│   ├── fullchain.pem            # 0644
│   └── privkey.pem              # 0600 (0600/0640+cert_group when set)
└── current -> <fingerprint>/    # symlink, swapped atomically
```

- The server validates the manifest (ETag + fingerprint shape + safe
  domain paths) before writing; any invalid entry aborts the whole sync.
- Files are written straight into the content-addressed version directory
  (`<fingerprint>/`, so re-syncing the same certificate is idempotent and a
  crashed write leaves the old version intact); `current` then swaps via a
  temp symlink + rename — readers never see a missing or half-updated
  pointer, and a `current` that is a real directory is refused instead of
  overwritten.
- On any write/test/reload failure the node rolls the symlinks back to
  the previous state and does NOT advance its stored ETag; the next loop
  retries.
- The server also writes the decoy nginx configuration (next section) and
  restarts nginx when it is found stopped, on every poll.
- GeoIP/GeoSite data lives in `/var/lib/vela/assets/geoip.dat` and
  `geosite.dat` (see the update section above); a stale `.prev` sibling is
  the last rollback copy.

## nginx decoy configuration (generated by vela-server)

The image ships nginx with no default site; the server renders exactly one
file from the certificate manifest at the path it was enrolled with
(`--nginx-conf-path`). The provisioning template uses
`/etc/nginx/http.d/vela-decoy.conf`; a container built on a
Debian/Ubuntu/RHEL base uses `/etc/nginx/conf.d/vela-decoy.conf`.

One `server` block per assigned certificate, listening **only** on the
decoy's Unix socket, plus one plain-HTTP block that redirects everything to
HTTPS:

```nginx
# Managed by vela-server. Regenerated from GET /api/node/certs on every sync;
# edits are overwritten. Xray owns 443 — this decoy listens on a Unix socket
# (REALITY's dest) only, and redirects plain HTTP on :80 to HTTPS.

server {
    listen 80 default_server;
    server_name <domain> [<domain> ...];
    return 301 https://$host$request_uri;
}

server {
    listen unix:/dev/shm/lessv-decoy.sock ssl default_server;
    server_name <domain>;

    ssl_certificate     /etc/vela/certs/<path>/current/fullchain.pem;
    ssl_certificate_key /etc/vela/certs/<path>/current/privkey.pem;
    ssl_protocols       TLSv1.3;
    ssl_ecdh_curve      X25519MLKEM768:X25519;

    server_tokens off;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src https://api.ipify.org https://api64.ipify.org; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;

    root  /var/www/vela-decoy;
    index index.html;

    location = /robots.txt {
        default_type text/plain;
        return 200 "User-agent: *
Disallow: /
";
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
```

- **Post-quantum, without a fallback.** `ssl_ecdh_curve
  X25519MLKEM768:X25519` makes a TLS 1.3 handshake prefer the ML-KEM-768 +
  X25519 hybrid and fall back to X25519 for clients that do not offer it.
  The linked TLS library resolves the group at `nginx -t` time: OpenSSL ≥ 3.5
  knows it, and the image pins one that does. There is **no classical-only
  render**: the apply fails, the previous nginx config is restored, and the
  server reports `nginx_ok: false` with the `nginx -t` output.
- **Local socket, not a port.** The decoy's only listener is
  `/dev/shm/lessv-decoy.sock`; REALITY relays every handshake there, so the
  stolen origin never touches the network stack. The path is shared memory
  inside the container and the plane renders it as `dest`, so it is part of
  the wire contract. An authored `dest` that is
  not this socket (for example `127.0.0.1:8443`) is a lint warning and a
  broken fallback — the compatibility loopback listener was removed.
- **Plain HTTP only redirects.** The `:80` block answers every assigned name
  with `301 https://$host$request_uri`; it carries no certificate. Port 80
  must be free (the installer removes the distribution's default site), and a
  bind conflict fails `nginx -t`/reload, which surfaces as a cert-stage
  failure instead of a silent half-config.
- **Anti-crawl headers and a managed page.** The decoy sends `X-Robots-Tag:
  noindex, nofollow, noarchive, nosnippet`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `nosniff`, a restrictive CSP, and a
  `robots.txt` that disallows everything. `index.html` is rendered by the
  server from a template that starts with `<!-- vela-server-decoy-page -->`:
  while that marker is present the page follows image upgrades; delete the
  marker to keep your own page untouched.
- `nginx_socket` in `/etc/vela/node.toml` moves the socket (absolute path;
  keep the preset's `dest` in sync). Both services run as root here, so the
  socket's default ownership is enough; with a non-root Xray, set
  `user=`/`group=` on the `listen` line instead.
- nginx starts before Xray in the image (the socket must exist before the
  first handshake) and s6 restarts either process that dies.
- Wildcard certificates use `wildcard.<zone>` as the `path` and the wildcard
  name as `server_name`.
- The file references `current`, so certificate renewals need no nginx config
  change — the reload after each sync picks the new bytes.
- `cert_group` is only needed when nginx does not run as root; Debian's
  master runs as root, so `0600` alone is fine.
- Never configure nginx to listen on 443: REALITY owns that port.

### Trusting the staging root

A node on `cert_environment: staging` serves the Let's Encrypt staging
chain. REALITY clients do not need the CA (they validate the REALITY
handshake, not the decoy site chain), but browsers and `curl` do. Install
the staging root into the test client's trust store:

```sh
curl -fsSL -o /usr/local/share/ca-certificates/le-staging-root-x1.crt   https://letsencrypt.org/certs/staging/letsencrypt-stg-root-x1.pem
update-ca-certificates
```

Alpine: `apk add ca-certificates` and put the PEM in
`/etc/ssl/certs/` after `update-ca-certificates` (or use `-k` for a
one-off check).

## Routine operations

`ADMIN_KEY` below is any panel key: mint one with `node
scripts/admin_key.mjs create --label ops --out .env.admin`, then
`ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.admin | cut -d= -f2-)`.

```bash
# issue / re-issue (forced renewal) for a domain
curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"confirm":"<domain>"}' https://<cp>/api/admin/cert-domains/<id>/issue

# watch an issuance
curl -sS -H "Authorization: Bearer $ADMIN_KEY" https://<cp>/api/admin/cert-domains/<id>/runs

# certificate state the node reports (admin view)
curl -sS -H "Authorization: Bearer $ADMIN_KEY" https://<cp>/api/admin/nodes/<id>/certs
```

Server side, from the host (the compose file lives at `/etc/vela/compose.yaml`):

```bash
docker compose -f /etc/vela/compose.yaml ps
docker compose -f /etc/vela/compose.yaml logs -n 100 vela-server
docker exec vela-server xray run -test -c /var/lib/vela/config.json
docker exec vela-server nginx -t
docker exec vela-server ls -l /etc/vela/certs/<path>/
docker exec vela-server readlink -f /etc/vela/certs/<path>/current
```

## Troubleshooting playbook (in order)

1. **Panel: Certificates page → domain → Runs.** The LE error is verbatim
   (`caa`, `rateLimited`, `dns problem`, expired order...). Phase tells you
   where it died.
2. **Panel: node sync** (`GET /api/admin/nodes/<id>/sync`): `nginx_ok`,
   `nginx_error`, and certificate lint warnings (`serverNames ... is not
   covered by an assigned certificate`, `dest ... is not a local Unix socket
   or 127.0.0.1:<port>`, invalid `shortIds`).
3. **Server**: `docker compose -f /etc/vela/compose.yaml logs -n 100`;
   `docker exec vela-server ls -l /etc/vela/certs/<path>/`;
   `docker exec vela-server readlink -f .../current`. The state file
   (`/var/lib/vela/state.json` inside the `vela-state` volume) carries
   `cert_etag`, `cert_synced_at`, `last_nginx_ok`, and `certs` (the
   certificate set the decoy config was rendered from; used to notice that a
   server upgrade made the generated file stale). The decoy page lives at
   `/var/www/vela-decoy/index.html`.
4. **nginx**: `docker exec vela-server nginx -t`; the error log is in
   `docker compose logs`.
5. **HTTP checks**: `curl -v https://<domain>` (must validate without
   `-k`); `openssl s_client -connect <host>:443 -servername <domain>`.
6. **Xray**: `docker exec vela-server xray run -test -c
   /var/lib/vela/config.json`; its log is in `docker compose logs`. Cert
   issuance and nginx reload must never restart Xray.
7. **Artifacts missing**: the bytes live in D1, in `certificate_artifacts`,
   keyed by certificate id (`SELECT certificate_id, cert_pem IS NOT NULL,
   chain_pem IS NOT NULL, fullchain_pem IS NOT NULL FROM certificate_artifacts
   WHERE certificate_id = '<id>'`). The admin download endpoint reads the same
   rows, so it answers 500 with the same id and field names. Do not hand-edit
   `current` — the server reconciles it; a manual pointer will be overwritten
   or rolled back on the next sync.

### Failure cookbook

| Symptom | Meaning | First fix |
|---|---|---|
| `wait-propagation` loops then fails | TXT record not visible to DoH resolvers | check the `_acme-challenge` TXT in the Cloudflare dashboard; check the DNS token's zone scope |
| LE CAA error on a name | a CAA record forbids issuance | fix/remove the CAA record (`0 issue "none"` blocks everything) |
| `too many certificates already issued` | production rate limit | wait; use staging for any further testing |
| panel warning `nginx is not healthy: nginx unit is not active` | nginx stopped/crashed — the text after the colon is the server's `nginx_error` field | the server restarts nginx on its next poll; if it stays down, read `docker compose logs` |
| `nginx -t rejected the decoy (post-quantum X25519MLKEM768:X25519 requires OpenSSL >= 3.5): SSL_CTX_set1_curves_list(...) failed` | the nginx inside the image cannot negotiate the hybrid group; the server refuses to serve classical-only TLS and restored the previous decoy config | unexpected in a shipped image (it pins a TLS library that knows the group); check which image tag runs and rebuild |
| server reports cert failure, files unchanged | artifact read/validate failed | the error names the certificate id and the missing field; the admin download endpoint reads the same rows — do not edit files by hand |
| renewed cert never appears on the node | assignment changed or ETag stuck | re-check assignment; compare `nodes.cert_etag` (the node's adopted ETag) with the manifest ETag from `GET /api/node/certs` — equal means the node already has this version |

## Tearing down a node VPS

Stop the container and remove its volumes first, so nothing keeps running
with a revoked identity:

```bash
docker compose -f /etc/vela/compose.yaml down -v
```

Then destroy the VPS through its provider, then delete the node with
`DELETE /api/admin/nodes/<id>` (or the node page's **Delete node**): one
batch removes the row plus its token, config, user access, endpoint
registry, REALITY keys, and certificate assignments.
Domain-scoped evidence (cert domains, certificates, issue runs) is untouched,
and the machine keeps running its last applied config until the container
stops — decommission it separately. The plane keeps domain/cert records;
soft-deleted cert domains disappear from the UI but their history stays in
the database.
