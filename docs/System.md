# System Diagram

```mermaid
flowchart LR
    subgraph Users["Users"]
        Admin["Admin user"]
        AppUser["Approved user"]
    end

    subgraph Entra["Microsoft Entra (OAuth / OIDC)"]
        IdP["Identity provider<br/>swappable to Okta/etc."]
    end

    subgraph Vercel["Vercel — Next.js app"]
        ChatUI["Chat UI"]
        AdminUI["Admin dashboard<br/>(access + doc mgmt)"]
        DocUI["Document mgmt UI"]
        API["API routes /<br/>server actions"]
        AgentLayer["Multi-agent layer<br/>(prompt-injection checks)"]
        AuthJS["Auth.js<br/>(NextAuth)"]
    end

    subgraph NeonApp["Neon Postgres — app DB"]
        TblUsers[("users + access tiers")]
        TblDocs[("document metadata")]
        TblChat[("chat history")]
    end

    Blob[("Vercel Blob<br/>uploaded files")]
    LLM["LLM API<br/>(provider TBD)"]

    subgraph DO["DigitalOcean droplet — Reserved IP (whitelisted)"]
        Gateway["P21 gateway<br/>(Node service, HTTPS)"]
    end

    subgraph NeonAudit["Neon Postgres — audit DB (isolated project)"]
        TblAudit[("query audit log<br/>user · query · row count")]
    end

    subgraph Olander["Olander tenant"]
        the hosting provider["the hosting provider middleware<br/>(P21 API host)"]
        P21[("Epicor Prophet 21<br/>SQL — read only")]
    end

    Admin -->|HTTPS| Vercel
    AppUser -->|HTTPS| Vercel

    AuthJS <-->|OAuth| IdP
    API --> AuthJS

    ChatUI --> API
    AdminUI --> API
    DocUI --> API

    API --> TblUsers
    API --> TblDocs
    API --> TblChat
    API <-->|upload / fetch| Blob

    API --> AgentLayer
    AgentLayer <--> LLM

    AgentLayer -->|on-demand LLM tool call:<br/>P21 query per user request| Gateway
    Gateway -->|write audit row| TblAudit
    Gateway -->|HTTPS<br/>whitelisted IP| the hosting provider
    the hosting provider --> P21

    classDef ext fill:#fff3e0,stroke:#e65100,color:#000
    classDef db fill:#e3f2fd,stroke:#1565c0,color:#000
    classDef app fill:#e8f5e9,stroke:#2e7d32,color:#000
    class IdP,LLM,the hosting provider,P21 ext
    class TblUsers,TblDocs,TblChat,TblAudit,Blob db
    class ChatUI,AdminUI,DocUI,API,AgentLayer,AuthJS,Gateway app
```

## Trust boundaries

- **Browser ↔ Vercel** — TLS, session cookie issued by Auth.js after Entra OAuth.
- **Vercel ↔ Neon (app DB)** — connection string in Vercel env; app DB holds no P21 data.
- **Vercel ↔ DO gateway** — HTTPS; gateway is the *only* path to P21 and the only host with a whitelisted IP. Same IP for dev and prod (one whitelist entry at the hosting provider). P21 is queried **on demand** as an LLM tool call during a user's chat turn — we do **not** sync or cache ERP data locally, so we stay a query path rather than becoming a data custodian.
- **Gateway ↔ the hosting provider ↔ P21** — read-only API access, IP-whitelisted at multiple layers, scoped to Olander's tenant.
- **Audit DB** — isolated Neon project; gateway writes every P21 call (app user, query, row count) before forwarding. Separate from app DB so a compromise of the app can't rewrite history.

## Phase mapping

- **Phase 1** — everything inside Vercel + app DB + Blob + Auth.js. Gateway and audit DB stubbed.
- **Phase 2** — gateway live, IP whitelisted, P21 read path wired through agent tool calls.
- **Phase 3** — audit log enforced on every gateway call; multi-agent prompt-injection layer hardened.
