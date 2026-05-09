# OlanderAgents

Scope of work for the Olander Agents project.

## Status: ready to go, awaiting data

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in values once provisioned
npm run dev
```

App runs at http://localhost:3000.

Other scripts:

- `npm run build` — production build
- `npm run lint` — ESLint
- `npm start` — serve production build
- `npm run db:generate` — generate a Drizzle migration from `src/db/schema.ts`
- `npm run db:migrate` — apply migrations to the DB at `DATABASE_URL`
- `npm run db:studio` — open Drizzle Studio against the DB

Stack: Next.js 16 (App Router, TypeScript, Tailwind, ESLint, `src/`, `@/*`), Auth.js v5 with the Microsoft Entra provider, Drizzle ORM over Neon Postgres.

### First-time DB setup

1. Create a Neon project, copy the pooled connection string into `.env.local` as `DATABASE_URL`.
2. Register an app in Microsoft Entra (Azure portal). Add redirect URI `http://localhost:3000/api/auth/callback/microsoft-entra-id` for dev. Drop the client ID, secret, and tenant ID into `.env.local`.
3. Generate `AUTH_SECRET` with `openssl rand -base64 32`.
4. Run `npm run db:generate` to produce the initial migration, then `npm run db:migrate` to apply it.

Other docs live in [`docs/`](./docs): [Assignments](./docs/Assignments.md), [System diagram](./docs/System.md), [P21 connection](./docs/P21_Connection.md).

## Phase 1

Build out the frontend with a placeholder backend. We don't have the real data yet, but we're assuming it's mostly documents and spreadsheets. We'll get more specific once we actually see it.

What we need to build:

- A document management system so we can keep track of what's been uploaded and where it lives. This basically means the DB and a UI to access it. this will be a super important decison and a hard one to make given that there will be varied document types and security is important. be prepared to justify this decision
- An admin dashboard. right now I think this should focus on who has access to the platform. maybe just some way to allow specific users, but this will need to work with OAuth. Also part of this dashboard will need to coexist with the document management system so prepare for that integration as these are both admin level features 
- A chat UI for talking to the agents. prepare it to work with the data get everything set up so that once the data is there we are ready to go. this page should be accesible to both normal (approved) users and admin

### Tech stack

Picked to keep recurring costs near zero — Olander is already on the hook for LLM API pricing, so everything else lives on free tiers or minimal infra.

- **Frontend + backend:** Next.js on Vercel. One app, API routes / server actions handle the backend.
- **Database:** Neon Postgres for users, access tiers, document metadata, and chat history. A second Neon project holds the Phase 3 audit log, isolated from the app DB.
- **Document storage:** Vercel Blob for uploaded files. The app DB only stores metadata.
- **Auth:** Auth.js (NextAuth) with the Microsoft Entra provider by default. Single tenant, so no need for a multi-tenant SSO vendor. If Olander later wants to bring their own IdP (Okta, etc.), it's a config swap to Auth.js's generic OIDC/SAML provider — we eat the dev work, they avoid per-user fees.
- **LLM:** Anthropic API. A multi-agent layer in the backend handles prompt injection checks
- **Static egress to P21:** single DigitalOcean droplet with a Reserved IP, running a small Node "P21 gateway" service. Vercel calls the gateway over HTTPS; the gateway writes the Phase 3 audit row to the separate Neon project, then forwards to P21. Same gateway and same whitelisted IP serve dev and prod — the hosting provider only has to whitelist one address. Reserved IP is free while attached and survives droplet rebuild, so we can replace the host without re-asking for a whitelist update. Picked over AWS EC2+EIP (no surprise per-GB egress bills, simpler ops handoff), Hetzner (US-based provider is a cleaner trust posture for an ERP data path), and Vercel Secure Compute / shared-IP PaaS options (enterprise pricing or shared IPs that leak other tenants into the whitelist).

## Phase 2

Hook up real data.

### Data access plan (from Olander correspondence)

Olander runs Epicor Prophet 21 (P21) as their ERP. They own the P21 API, hosted on a middleware server managed by the hosting provider. We'll get READ ONLY access to the SQL database files through that API, gated by IP whitelisting at multiple security layers.

plan:
1. the provider contact creates a user account in Olander's P21 environment for our team so we can poke around and see where fields live.
2. We send the provider contact the IP addresses we'll connect from. He forwards to the hosting provider for whitelisting.
3. the provider contact sends API docs and we schedule a P21 walkthrough meeting.
4. Initial access is to **dev/play data only**. Production data comes after the AI app is built out and trust is established.
5. Access levels need to be set up so different user tiers see different data.
6. Everything stays within Olander's tenant — not shareable outside the company.

Open item on our side:
- Devs are on dynamic IPs (CGNAT), so we need a static IP before the provider contact can whitelist. **Decided:** single DigitalOcean droplet with a Reserved IP, running a P21 gateway service (see tech stack). Same IP for dev and prod — the hosting provider only whitelists one address. Alex to provision the droplet, reserve the IP, and send it to the provider contact, then follow up to get the P21 walkthrough on the calendar.

## Phase 3

Security review

This is extremely important. we will have a whitelisted IP with full ERP API access. this needs to be locked down.

We will need to set up a full query audit log where every P21 call recorded with the app user who triggered it, the query, and the row count. make sure its stored outside the app DB.

Prompt injection. We will likley use multiagent architecture to check for prompt injection.

## Questions for Olander

What tiers of access are needed. this will likley be determined by what P21 data the AI agent can access so we will want to get specific about that.

What sort of login do you prefer, we have planned for Microsoft Oauth but we can set up SSO with your provider if you use Okta or similar
