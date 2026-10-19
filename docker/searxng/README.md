# SearXNG for Nango

SearXNG is a self-hosted metasearch engine. Nango's built-in `web_search`
tool can use it as a search provider, so agents can search the web without
sending queries to a commercial search API.

This directory contains the configuration used by both:

- the root [`docker-compose.yaml`](../../docker-compose.yaml) `searxng`
  service (recommended when Nango itself runs in Docker), and
- the standalone [`docker-compose.yaml`](./docker-compose.yaml) in this
  directory (for `pnpm dev` on the host).

## Quick start

### Integrated with the Nango stack

```bash
# From the repository root
docker compose up -d searxng
```

SearXNG is reachable:

- from the `nango-app` container: `http://searxng:8080`
- from the host: `http://127.0.0.1:8680`

Use the first URL in the Nango credential only when the app runs in Docker;
a host-run `pnpm dev` process must use `127.0.0.1`.

### Standalone (host-based development)

```bash
cd docker/searxng
# Compose reads .env from this directory; reuse the repository root
# file (which contains SEARXNG_SECRET) or export the variable inline.
docker compose --env-file ../../.env up -d
```

SearXNG is then reachable from the host at `http://127.0.0.1:8680`.

Do not run the standalone compose file while the root stack is already
running: both define a container named `searxng` and bind port 8680.

## `SEARXNG_SECRET` is not an API key

SearXNG's `/search` endpoint is **unauthenticated**. Anyone who can reach
the port can query it. `SEARXNG_SECRET` maps to `server.secret_key` and is
used to sign session cookies and CSRF tokens; it never authenticates API
requests and there is no bearer-token check to configure.

The compose files fall back to `local-searxng-secret-change-me` when the
variable is unset, so `docker compose` commands keep working out of the
box. That fallback is only appropriate for local development. Set a
stable random value in `.env` for stable sessions and any non-local
deployment:

```bash
# Generate once; reuse across restarts so cookies survive.
openssl rand -hex 32
```

```dotenv
SEARXNG_SECRET=<generated-value>
```

Because the service is bound to `127.0.0.1` by default, the unauthenticated
endpoint is only reachable from the host (and, for the integrated compose
setup, from other containers on the compose network). If you expose it
beyond loopback, put it behind an authenticating reverse proxy and enable
the limiter (see below).

## Verify the JSON API

`/healthz` only checks that the web process is alive. It does **not** prove
that the JSON format or upstream engines work. Run both checks after a
configuration change:

```bash
curl -fsS http://127.0.0.1:8680/healthz
# OK

curl -fsS 'http://127.0.0.1:8680/search?q=test&format=json' | head -c 300
# {"query":"test","number_of_results":...,"results":[...]}
```

If the second command returns HTML or HTTP 403, `search.formats` does not
include `json`.

## Configure the Nango credential

1. Open **Admin → Credentials → Search → New Credential**.
2. Provider: **SearXNG**.
3. **Base URL or Host** — choose based on where the Nango process runs:
   - `http://searxng:8080` when `nango-app` runs in the root Docker compose stack.
   - `http://127.0.0.1:8680` when Nango runs on the host (`pnpm dev`).
4. **Credential Type / API Key**: the form requires a value, but SearXNG
   does not use one. Enter `none`, `empty`, or `anonymous`; the runtime
   treats these as anonymous placeholders and the SearXNG provider sends
   no `Authorization` header. Do not use a real secret here.
5. Save and ask an agent to search the web. The outcome card reports
   `via searxng`.

> **Host vs Docker URL:** `http://searxng:8080` is a Docker-network service
> name. A host-run `pnpm dev` process cannot resolve it and fails with
> `fetch failed` / `getaddrinfo ENOTFOUND searxng`; use
> `http://127.0.0.1:8680` there. Conversely, inside the `nango-app` container
> `127.0.0.1` refers to the container itself, not the host.

## Configuration

### SearXNG (`core-config/settings.yml`)

| Key | Purpose |
|---|---|
| `use_default_settings: true` | Load default engines/categories before applying overrides |
| `general.instance_name` | Name shown in the SearXNG UI |
| `server.limiter: false` | Disable per-IP rate limiting for the local single-user instance |
| `server.image_proxy: true` | Proxy images in the SearXNG UI (does not rewrite JSON thumbnail URLs) |
| `server.method: GET` | HTTP method for search requests |
| `search.formats: [html, json]` | Required — JSON is disabled by default |
| `outgoing.request_timeout` | Per-engine upstream timeout |
| `outgoing.max_request_timeout` | Hard ceiling per upstream request |

`server.secret_key` is supplied through `SEARXNG_SECRET`; do not commit it
to this file.

### Nango (`Admin → Config`)

| Key | Default | Purpose |
|---|---|---|
| `web_search.timeout` | `30` | Wall-clock budget for one `web_search` call (seconds) |
| `web_search.searxng.language` | `""` | Language code passed to SearXNG; empty = instance default |
| `web_search.searxng.categories` | `general` | Comma-separated categories, e.g. `general,news` |
| `web_search.searxng.safesearch` | `0` | `0` off, `1` moderate, `2` strict |
| `web_search.searxng.include_thumbnails` | `false` | Forward `thumbnail` / `img_src` URLs as result images |

Thumbnails are off by default because SearXNG's `image_proxy` only covers
its own UI; the JSON URLs are hotlinked by the browser directly to the
origin site, which leaks the user's IP and undermines the privacy goal.

## Troubleshooting

### Container is unhealthy

The healthcheck uses `wget --spider http://127.0.0.1:8080/healthz`. Check
container logs first:

```bash
docker compose logs searxng
```

### HTTP 403 from `/search?format=json`

`search.formats` does not contain `json`. Add it in `settings.yml` and
restart the container:

```bash
docker compose restart searxng
```

### HTTP 429

The limiter rejected the request. For local use set
`SEARXNG_LIMITER=false` (or `server.limiter: false` in `settings.yml`).
For a public instance, enable the limiter and configure Valkey instead of
disabling it.

### Startup log: `ahmia` / `torch` can't register

The default engine set includes Tor-only engines. Without a Tor proxy they
fail to register at startup; general web search is unaffected. Disable
them in `settings.yml` if the log noise is unwanted.

### Search returns zero results

Check the container logs and the `unresponsive_engines` field in the JSON
response. Common causes are blocked upstream engines, an outbound proxy
requirement, or a very restrictive `categories` value.

### `SEARXNG_SECRET` is unset

Compose uses the local-development fallback, so searches still work. Set a
random value in `.env` (see above) for stable sessions and any non-local
deployment; do not commit the real value.

## Updating SearXNG

The image tag is pinned in both compose files. To upgrade:

1. Pick a new tag from <https://hub.docker.com/r/searxng/searxng/tags>.
2. Update the tag in the root and standalone compose files together.
3. Re-run the `/healthz` and `format=json` checks.

## Resources

- [SearXNG documentation](https://docs.searxng.org)
- [SearXNG search API](https://docs.searxng.org/dev/search_api.html)
- [SearXNG settings reference](https://docs.searxng.org/admin/settings/)
- [SearXNG Docker installation](https://docs.searxng.org/admin/installation-docker.html)
