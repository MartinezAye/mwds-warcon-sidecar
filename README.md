# MyWardogsStats Warcon sidecar

## What this is

A small helper container that runs next to your Warcon and sends your server's match data to MyWardogsStats: who is on, their team, kills, deaths, cash and ping, the team scores and the map. That gives your server per-team playtime, real wins and population on MyWardogsStats. Nothing in Warcon changes. The container opens no ports. It reads Warcon with a view-only key and refuses to start with any stronger key.

## Who should use it

| Your setup | Use |
|---|---|
| You run your own Warcon with Docker Compose | this sidecar |
| Shared or hosted Warcon, or no Warcon | the RCON option in the MyWardogsStats owner portal. Nothing to install |

The sidecar adds team data on top of the event feed. Keep the `EventFeedEndpoints` line from the portal in your game config either way.

## Before you start

- Warcon running with Docker Compose, and you can edit its `docker-compose.yml`.
- You are an owner of the Warcon organisation that runs the server. Only owners can make API keys.
- A MyWardogsStats account, with a community and the server registered in the owner portal.
- A machine that can pull from `ghcr.io`. Images exist for `linux/amd64` and `linux/arm64`.

## Step by step

### 1. Get the feed token

1. In the MyWardogsStats owner portal, open the server, then **Feed tokens**.
2. Create a token and copy it. It starts with `mwds_` and is shown once.
3. Also copy the `Url="..."` value from the paste block on the same page. That is your ingest address.

If the server already has a token in its `EventFeedEndpoints` line, you can use that same token.

### 2. Create the Warcon API key

1. In Warcon, click **Orgs** in the top bar and open your organisation.
2. In the **API keys** section, click **New key**.
3. Fill in the form:

   | Field | Set it to |
   |---|---|
   | Label | `MyWardogsStats` |
   | May | **View** only. Untick everything else |
   | Servers | untick **Every server in the organisation, including ones added later**, then tick only the server(s) this sidecar sends |
   | Expires | `never`, or a date you will remember. An expired key stops the sidecar |

4. Click **Create key**. Copy the key from **API key ready**. It starts with `wck_` and is shown once.
5. Note the Warcon server id: open the server in Warcon; the address ends in `/server/<id>`. Copy that id.

### 3. Make the settings file

In the folder that holds Warcon's `docker-compose.yml`, create a file named `mwds-sidecar.env`:

```
WARCON_API_KEY=wck_your_key_here
WARCON_SERVER_ID=your_warcon_server_id
MWDS_FEED_TOKEN=mwds_your_token_here
MWDS_INGEST_URL=paste the Url value from the portal paste block
```

Then make it readable only by you:

```
chmod 600 mwds-sidecar.env
```

| Name | Required | Example | What it does |
|---|---|---|---|
| `WARCON_API_KEY` | yes | `wck_...` | the View-only key from step 2 |
| `WARCON_SERVER_ID` | yes, for one server | `fd359609-3d96-4e99-9963-22971c78d0d5` | the Warcon server to read |
| `MWDS_FEED_TOKEN` | yes, for one server | `mwds_...` | the token from step 1 |
| `MWDS_INGEST_URL` | yes | the `Url="..."` value from the portal | where samples go. Copy it from the portal, do not guess it. The `/v1/ingest` ending is fine |
| `MWDS_SERVERS` | for several servers | see [Several servers](#several-servers-on-one-warcon) | replaces `WARCON_SERVER_ID` and `MWDS_FEED_TOKEN` |
| `WARCON_URL` | no | `http://warcon:3000` | how the sidecar reaches Warcon. The compose snippet sets it |
| `SAMPLE_SECONDS` | no | `20` | seconds between samples while players are on, 10 to 300. Empty servers: every 60 s |
| `SPOOL_MAX_HOURS` | no | `24` | hours of data kept on disk while MyWardogsStats is unreachable, 0 to 72. `0` turns it off |
| `SPOOL_DIR` | no | `/data` | where that queue lives inside the container |
| `LOG_LEVEL` | no | `info` | `error`, `warn`, `info` or `debug` |

Use a separate file, not Warcon's `.env`, so the sidecar never sees Warcon's own secrets. Never commit this file or share it.

### 4. Add the service

Open `docker-compose.yml`. Under the existing `services:` line, at the same indent as `warcon:`, paste:

```yaml
  mwds-sidecar:
    image: ghcr.io/martinezaye/mwds-warcon-sidecar:0.1.0
    restart: unless-stopped
    env_file: mwds-sidecar.env
    environment:
      WARCON_URL: http://warcon:3000
    volumes:
      - mwds-sidecar-data:/data
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    mem_limit: 128m
    pids_limit: 64
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
    depends_on:
      warcon:
        condition: service_started
```

Under the `volumes:` line at the bottom of the file, next to `warcon-db:`, add:

```yaml
  mwds-sidecar-data:
```

The result looks like this:

```yaml
services:
  migrate:
    ...
  warcon:
    ...
  worker:
    ...
  db:
    ...
  mwds-sidecar:
    image: ghcr.io/martinezaye/mwds-warcon-sidecar:0.1.0
    ...

volumes:
  warcon-db:
  mwds-sidecar-data:
```

The whole block is also in `docker-compose.snippet.yml` in this repository.

- If your Warcon service is not called `warcon` (for example a single-container install), change `WARCON_URL` and `depends_on` to its name.
- No registry access? Replace the `image:` line with `build: https://github.com/MartinezAye/mwds-warcon-sidecar.git#v0.1.0` and Docker builds it from the tagged source.

### 5. Start it

```
docker compose up -d mwds-sidecar
```

### 6. Check it works

```
docker compose logs -f mwds-sidecar
```

Each log line is one JSON object. Within a few seconds you should see these `msg` values, in order:

| `msg` | Means |
|---|---|
| `Starting` | settings read. Lists your Warcon server ids and token variable names, never the values |
| `Warcon key scope checked` | the key holds `"capabilities":["server.view"]` and reaches exactly your servers |
| `Reading the Warcon live view` | connected to Warcon |

Every 5 minutes a `Health` line follows. For each server, look for `"ingest":"ok"`, `"approved":true` and a growing `samplesPosted`. Press Ctrl+C to stop following the log; the container keeps running.

Then, once staff have approved the server, its MyWardogsStats page shows teams and playtime per faction for players who joined after the sidecar started.

`docker compose ps mwds-sidecar` shows `healthy` while the container runs.

### Several servers on one Warcon

1. Make one Warcon key that covers exactly those servers (step 2, tick each one).
2. Get one feed token per server (step 1).
3. In `mwds-sidecar.env`, leave out `WARCON_SERVER_ID` and `MWDS_FEED_TOKEN`. Map each Warcon server id to a variable named `MWDS_FEED_TOKEN_<NAME>`, and put each token in its variable:

```
WARCON_API_KEY=wck_your_key_here
MWDS_INGEST_URL=paste the Url value from the portal paste block
MWDS_SERVERS=fd359609-3d96-4e99-9963-22971c78d0d5:MWDS_FEED_TOKEN_EU1,0b7d2f61-8f0e-4a51-9d55-0d3c3c1e8a10:MWDS_FEED_TOKEN_EU2
MWDS_FEED_TOKEN_EU1=mwds_token_for_eu1
MWDS_FEED_TOKEN_EU2=mwds_token_for_eu2
```

Up to 16 servers. Every server needs its own token.

## Updating

1. In `docker-compose.yml`, change the tag on the `image:` line to the new version, for example `:0.2.0`. Releases are listed on the GitHub releases page of this repository.
2. Run:

```
docker compose pull mwds-sidecar && docker compose up -d mwds-sidecar
```

Queued data on the `mwds-sidecar-data` volume survives updates.

## Removing it

1. Delete the `mwds-sidecar:` block and the `mwds-sidecar-data:` volume line from `docker-compose.yml`.
2. Run `docker compose up -d --remove-orphans`, then `docker volume rm <project>_mwds-sidecar-data` (`docker volume ls` shows the exact name).
3. Delete `mwds-sidecar.env`.
4. In Warcon, **Orgs**, your organisation, **API keys**: click **Revoke** on the `MyWardogsStats` key.
5. In the MyWardogsStats portal, revoke the token, unless the game's `EventFeedEndpoints` line still uses it.

## Troubleshooting

Find the `msg` value in `docker compose logs mwds-sidecar`.

| Log line or symptom | Meaning | Fix |
|---|---|---|
| `Invalid configuration, exiting` | a setting is missing or malformed. `problems` names it, never its value | fix `mwds-sidecar.env`, then `docker compose up -d mwds-sidecar` |
| `Warcon rejected WARCON_API_KEY, check the key on the Warcon org page` | the key is wrong, revoked or expired | make a new key (step 2) |
| `Warcon rejected the API key, check WARCON_API_KEY` | the key was revoked or expired while running. Data is kept and retried every 10 minutes | make a new key, restart the sidecar |
| `The Warcon key holds more than server.view, make a key with View only` | the key can do more than view. `capabilities` lists what it holds | revoke it, make a View-only key |
| `The Warcon key holds no server.view on any server` | the key cannot see any server | make a key with View on your server |
| `The Warcon key does not reach every configured server` | `serverIds` lists servers the key cannot see | fix the server id, or tick that server on the key |
| `The Warcon key reaches servers this sidecar does not send, limit the key to the configured servers` | the key covers more servers than configured | make a key limited to these servers |
| `WARCON_URL does not answer like Warcon, check the address` | the address is not Warcon | set `WARCON_URL` to your Warcon service, port 3000 |
| `Warcon not reachable yet, retrying the key check` | Warcon is starting or down | wait. If it lasts, check `WARCON_URL` and that both services are in the same compose file |
| `Warcon live view unavailable, retrying` | Warcon is restarting or the connection dropped | none, it reconnects by itself |
| `Server registered but not approved yet` | the server is waiting for MyWardogsStats approval. Recent data stays in memory, nothing is queued to disk | wait for approval |
| `MyWardogsStats token rejected, check the feed token in the owner portal` | the token was revoked or mistyped | copy a current token from the portal, restart |
| `Server suspended by MyWardogsStats staff` | the server is suspended | contact MyWardogsStats staff |
| `MyWardogsStats unreachable (...), backing off` | ingest is down or this box has no internet | none. Data is queued on disk and sent oldest first when it is back |
| `MyWardogsStats is busy, retrying after ...` or `rate limited` | ingest asked it to slow down | none. It waits and sends the queue |
| `Outage queue write failed, data is kept in memory only` | the disk is full or `/data` is not writable | free disk space, check the volume |
| `Health` shows `queueDropped` growing | the queue hit its limit (`SPOOL_MAX_HOURS` or 50 MB per server) and dropped the oldest data | fix the outage cause; raise `SPOOL_MAX_HOURS` up to 72 if outages are long |
| `Could not write the heartbeat file, the container health check will fail` | `/data` is not writable | check the `mwds-sidecar-data` volume line |
| `docker compose ps` shows `unhealthy` | the process is stuck or `/data` is not writable | `docker compose restart mwds-sidecar`, then read the log |

## Security

| It can | It cannot |
|---|---|
| read what Warcon shows on the View page of the servers you picked | kick, ban, chat, change settings or run RCON. The key has no such rights, and the sidecar refuses a key that has them |
| send player and score samples to MyWardogsStats | open ports or accept connections |
| keep up to `SPOOL_MAX_HOURS` of samples on its own volume | read Warcon's database, Warcon's `.env`, or other servers |

- Your Warcon key and feed tokens stay in `mwds-sidecar.env` on your machine. They are never logged, never written to the queue, and removed from the process environment after start.
- The container runs as a non-root user, with a read-only filesystem except its data volume, and no added privileges.
- Images are built by GitHub Actions from tagged source, with a signed build provenance attestation: `gh attestation verify oci://ghcr.io/martinezaye/mwds-warcon-sidecar:0.1.0 --owner MartinezAye`.
- Report a vulnerability privately: see [SECURITY.md](SECURITY.md).

## Development

```
npm ci
npm run typecheck
npm run lint
npm test
npm run build
docker build -t mwds-warcon-sidecar:dev .
```

MIT licensed, see [LICENSE](LICENSE).
