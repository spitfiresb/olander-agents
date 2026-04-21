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

Hook up real data. We'll start with a small representative sample from one source so we can see how the agents behave against actual content before scaling it up.
