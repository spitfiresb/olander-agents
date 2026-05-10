# CLAUDE.md

<!-- BEGIN:nextjs-agent-rules -->
## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Critical references

### Data API (referred to as P21, Prophet 21, Epicor, Olander API)

- **Reaching the API** (the hosting provider whitelist, RFC1918 DNS override, browser tunneling): `docs/P21_Connection.md`
- **Droplet operations** (Caddy/TLS, install.sh, firewall, systemd, rebuild runbook): `docs/Droplet.md`
- **Integration status** (3-layer model, what's done, what's blocked, roadmap): `docs/P21_Integration.md`

### Database (Neon Postgres + Drizzle + Auth.js adapter)

- **Connection topology, schema, migration workflow, history of the Vercel-Neon consolidation**: `docs/db.md`. Read before touching `src/db/`, `drizzle/`, or anything that talks to Postgres. Especially: there is exactly **one** Neon project (`<neon-project-id>`, Vercel-managed) — do not create a second one.

## Product vision
Read `VISION.md` before making product decisions, adding features, or changing UX. Stability over features. Activation over new capabilities. No feature creep.

## Design

Refer to `DESIGN.md` before making design decisions.