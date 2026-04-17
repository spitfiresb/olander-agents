# OlanderAgents

Scope of work for the Olander Agents project.

## Phase 1

Build out the frontend with a placeholder backend. We don't have the real data yet, but we're assuming it's mostly documents and spreadsheets. We'll get more specific once we actually see it.

What we need to build:

- A document management system so we can keep track of what's been uploaded and where it lives.
- An admin dashboard that shows what each agent has access to, with the ability to add or remove sources.
- Authentication, so only the right people can log in and admins can manage users.
- A chat UI for talking to the agents. Non-functional for now, just the interface.

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
