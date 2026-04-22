# OlanderAgents

Scope of work for the Olander Agents project.

## Status: ready to go, awaiting data

## Phase 1

Build out the frontend with a placeholder backend. We don't have the real data yet, but we're assuming it's mostly documents and spreadsheets. We'll get more specific once we actually see it.

What we need to build:

- A document management system so we can keep track of what's been uploaded and where it lives. This basically means the DB and a UI to access it. this will be a super important decison and a hard one to make given that there will be varied document types and security is important. be prepared to justify this decision
- An admin dashboard. right now I think this should focus on who has access to the platform. maybe just some way to allow specific users, but this will need to work with OAuth. Also part of this dashboard will need to coexist with the document management system so prepare for that integration as these are both admin level features 
- A chat UI for talking to the agents. prepare it to work with the data get everything set up so that once the data is there we are ready to go. this page should be accesible to both normal (approved) users and admin

Before we start writing code, each of us should come in with a proposed tech stack. I'll bring one too. We'll talk through the tradeoffs and pick one together.

At a minimum, whatever we go with needs to cover:

- Hosted frontend
- Hosted backend
- An LLM provider and a way to call it
- Authentication
- A database
- Enough app scaffolding to support everything above

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
- Our devs are on dynamic IPs (CGNAT), so we need a static IP solution before the provider contact can whitelist. Leaning toward a DigitalOcean static-IP VM or AWS EC2 for dev, and a static egress proxy for production. Alex to confirm the approach and send an IP by end of weekend, then follow up to get a meeting on the calendar.

## Phase 3

Security review

This is extremely important. we will have a whitelisted IP with full ERP API access. this needs to be locked down.

We will need to set up a full query audit log where every P21 call recorded with the app user who triggered it, the query, and the row count. make sure its stored outside the app DB.

Prompt injection. We will likley use multiagent architecture to check for prompt injection.

## Questions for Olander

what tiers of access are needed. this will likley be determined by what P21 data the AI agent can access so we will want to get specific about that.