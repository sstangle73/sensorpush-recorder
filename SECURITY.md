# Security

## Reporting a vulnerability

Please report a security problem privately, not in a public issue. This project lives on [GitLab](https://gitlab.com/sstangle73/sensorpush-recorder) and is mirrored to GitHub, and either route works:
- **[Report a vulnerability](https://github.com/sstangle73/sensorpush-recorder/security/advisories/new)** on the GitHub mirror's *Security* tab, or
- a [GitLab issue](https://gitlab.com/sstangle73/sensorpush-recorder/-/issues/new) marked **confidential**.

Only you and the maintainer see either one. Say what you can of:
- the version or commit, and how the recorder was run (Docker, token on or off);
- how to reproduce it, or a proof of concept;
- what someone could do with it.

## What happens next

- You'll hear back within 7 days.
- Once it's confirmed, it gets fixed, and a GitHub security advisory is published that credits you, unless you'd rather not be named. A CVE is requested through GitHub when the problem warrants one.
- Please keep it private until a fix is out, or for 90 days after your report, whichever comes first.

This is a one-person project, and reports aren't paid.

## Supported versions

Only the latest `master` and the `latest` image get fixes.

## What's in scope

The recorder: its API, the Explorer UI, the Docker image and the MQTT bridge. These matter most:
- **The token and browser sessions:** anything that reaches the API without the token or a session while a token is set, other than `/health`, `/metrics`, the UI page and its icons, manifest and service worker, and the sign-in endpoint; anything that reads, leaks or replaces the token; or a session that outlives a token change or can be forged.
- **The SensorPush account:** anything that exposes the email, password or session the recorder holds.
- **Backups and restore:** reading, overwriting or restoring snapshots without the token, or a snapshot name that reaches outside `/data/backups/`.
- **Outbound requests:** a webhook or ntfy sink, or anything else, made to reach addresses the operator didn't intend.

Out of scope: a recorder run with no token set (the README says it's then open to anyone who can reach it), `/metrics` being readable without the token (documented, for scraping on a LAN), a deployment without TLS, and denial of service by sheer volume.

## Past advisories

- [GHSA-j7mj-3739-5mg9](https://github.com/sstangle73/sensorpush-recorder/security/advisories/GHSA-j7mj-3739-5mg9): before 1.0.1, any request carrying `Sec-Fetch-Site: same-origin` skipped the token. Found by the maintainer; fixed in 1.0.1.
