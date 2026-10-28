# Security

## Reporting a vulnerability

Report it privately through GitHub: the **Security** tab of this repository, then **Report a vulnerability**. Do not open a public issue.

Include what you found, how to reproduce it, and the version (image tag) affected. You get a reply in the advisory thread.

## Supported versions

Only the latest release gets fixes. Update by changing the image tag (see the README).

## Scope

| In scope | Out of scope |
|---|---|
| this container and its image | Warcon itself (report to the Warcon project) |
| how it handles the Warcon key and feed tokens | the MyWardogsStats website and ingest service (contact MyWardogsStats staff) |
| the outage queue on disk | your host, Docker or network setup |
