# mwds-warcon-sidecar

Container that reads a self-hosted Warcon live view and posts MyWardogsStats samples to `POST /v1/ingest/samples`. Sample building, faction rules, ingest result handling, the memory buffer and the outage queue match the MyWardogsStats WardogsJS plugin, so stats are the same whichever sender a server uses. Keep them in step.

## Stack

Node 24 (runs on 22.12+), TypeScript strict ESM (NodeNext), zod 4, pino, vitest, eslint 9 with typescript-eslint strict type-checked. Native `fetch`, no HTTP framework. Dependencies pinned exactly.

## Layout

| Path | Role |
|---|---|
| `src/main.ts` | boot: config, key scope check, stream, timers, signals |
| `src/config.ts` | env schema (zod strict), server map, secret scrub |
| `src/logger.ts` | pino with path redaction plus a log hook that masks every secret value |
| `src/warcon/schema.ts` | Warcon live, kills, outbox, servers and error shapes |
| `src/warcon/client.ts` | `checkKeyScope`, `WarconStream` (SSE connect, backoff, idle timeout) |
| `src/sse.ts` | SSE parser, 64 KB per event, 1 MB per buffer |
| `src/sample.ts` | `buildSample`, `factionOf`, freshness |
| `src/schema.ts` | ingest sample contract, mirrors the MyWardogsStats ingest schema with `source: "warcon"` |
| `src/ingest.ts` | `IngestClient`: batching, results, backoff, memory buffer, spool use, approval gate |
| `src/spool.ts` | JSONL outage queue with cursor, `spoolVersion`, approval marker |
| `src/sidecar.ts` | per-server agents, tick cadence, heartbeat, health line |
| `src/heartbeat.ts`, `src/healthcheck.ts` | Docker `HEALTHCHECK` (exec form, no shell) |
| `test/fixtures/warcon.ts` | Warcon shapes built from Warcon source (README live example, `types.ts`, `events.ts`, `access.ts`, `http.ts`) |

## Rules

1. No code comments, no em or en dashes, no emojis. Terse docs.
2. Secrets: `WARCON_API_KEY` and every feed token are read once, then deleted from `process.env`. Never logged, never written to disk, never in an error message. Logs carry HTTP status and a known error code, never a response body or Warcon error message.
3. Our own data is zod `.strict()`: config, samples, spool lines, cursor and marker files. Warcon answers are the one exception: parsed with plain `z.object` (unknown keys stripped) and `.max()` on every string and array, so a Warcon upgrade that adds a field does not stop samples. Malformed players and scores are dropped one by one and counted.
4. Every outbound request: timeout, `redirect: "error"`, capped body read.
5. The Warcon key must hold `server.view` only and reach exactly the configured servers. Checked at start and before every reconnect; anything else exits 1.
6. Bump `spoolVersion` whenever the spool line or sample shape changes. The first start on the new version discards the old queue.
7. Bump `agentVersion` in `src/version.ts` and `package.json` together.
8. Keep `src/schema.ts` in step with the ingest contract. A change there is an ingest change first.
9. Every GitHub Action pinned by commit SHA. Images publish only from a `v*` tag, with a provenance attestation.

## Facts (paths in the Warcon repository)

| Fact | Source |
|---|---|
| Live view is SSE: `event: <name>\ndata: <json>\n\n`, events `live`, `kills`, `outbox`; `: ping` every 15 s; the stream closes after 5 minutes and the client reconnects | `src/routes/api/live/events/+server.ts` |
| `passive=1` keeps the server cadence (no watched tier); `ids=a,b` limits servers; ids the caller cannot see are dropped; no ids left is 400 | same file |
| `live` data is `LiveView`; `kills` data is `{ type, serverId, kills: KillView[] }`; `outbox` only for keys with `automation.manage` | `src/lib/types.ts`, `src/lib/server/events.ts` |
| Players: `kills`, `deaths`, `cash` default to 0, `ping` to null, `faction` to null | `src/lib/server/actions.ts` (`players`) |
| Status: `serverName` and `map` default to `''`, `maxPlayers` and `playerCount` to 0, scores sanitised to `#rrggbb` or `''` | `src/lib/server/actions.ts` (`getStatus`), `src/lib/format.ts` (`saneScores`) |
| Cadence: hot server players 2 s, status 5 s; empty 30 s | `src/lib/server/settings.ts` |
| Keys: `Authorization: Bearer wck_` + 43 base64url; 401 `invalid_api_key`, `api_key_revoked`, `api_key_expired`; 403 `suspended` | `src/lib/server/apikeys-core.ts`, `src/lib/server/apikeys.ts`, `src/hooks.server.ts` |
| A key's scope: capabilities plus a server allowlist (null = every org server). Keys cannot be edited, only revoked | `src/lib/server/apikeys-core.ts` (`keyCoversServer`), `src/routes/api/orgs/[id]/keys/[keyId]/+server.ts` |
| `GET /api/servers` with a key lists the servers it covers with `caps` and `manager`; no `server.view` means an empty list | `src/lib/server/access.ts` (`accessibleServers`, `shapeServer`) |
| Errors: `{ ok: false, error: { message, code } }`; 429 has no `Retry-After` | `src/lib/server/http.ts`, `README.md` (Bots and API keys) |
| Compose: web service `warcon` on 3000, `worker` on 7700, default network | `docker-compose.yml`, `Dockerfile` |

## Verify

`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm audit --omit=dev`. Docker: `docker build -t mwds-warcon-sidecar:dev .` (CI builds amd64 and arm64 on every push). A live check needs a Warcon with a View-only key and an ingest reachable from the container.

## Release

1. Bump `agentVersion` in `src/version.ts`, `version` in `package.json`, and the image tag in `docker-compose.snippet.yml` and `README.md`.
2. Commit, tag `vX.Y.Z`, push the tag. `release.yml` checks the tag against `package.json`, builds `linux/amd64` and `linux/arm64`, pushes `ghcr.io/martinezaye/mwds-warcon-sidecar:X.Y.Z` and `:latest`, and attests provenance.
3. Make the GHCR package public once, after the first release.
