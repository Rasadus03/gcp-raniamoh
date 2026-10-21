# Real-Time Multi-User Chat System — Microservices Architecture, Frontend BFF & GCP Implementation

> **Specification Reference**:  
> This architecture, design specification, and full-stack microservices implementation were generated based on the **[Real-Time Multi-User Chat System Specification Document](https://docs.google.com/document/d/1_dCF0wfrX__W8cyqYVHYKz882pfCyeQdqVA0Ee6FQ2A/edit?tab=t.0)**.
>
> **Core Specification Requirements Addressed**:
> - **Functional Requirements**: Secure user authentication (JWT + `HttpOnly` `__Host-chat_session` cookies + CSRF protection), 1-on-1 Direct Messaging, Group Chat (Rooms/Channels), Real-Time Presence/Status (`ONLINE`, `OFFLINE`, `typing_indicator`), and persistent Message History.
> - **Scale & Performance Targets**: `<200ms` global end-to-end latency, `99.99%` availability SLA, `1,000,000` concurrent WebSocket connections, `10M+` DAU, `10,000 QPS` write throughput, and `50,000 QPS` read throughput.
> - **Microservices Architecture**:
>   1. **Auth Service**: Identity provider issuing signed JWTs, single-use WebSocket upgrade tickets (`wst_...`), and JTI revocation.
>   2. **API Gateway & Load Balancer / Frontend BFF**: Routing REST APIs (`/v1/*`) and relaying WebSockets (`/v1/stream`) with per-request cryptographic CSP nonces.
>   3. **Chat Service**: Stateful WebSocket gateway managers integrated with **Google Cloud Pub/Sub** (`chat-node-gateway-1`, `channel-broadcast-shard-0`).
>   4. **Storage Layer**: Dual-database persistence in **Google Cloud Spanner** (`chat-spanner-instance/chat-db`) and **Google Cloud Firestore in Native Mode** (`chat-system-db`), plus ephemeral TTL-backed presence & typing state.

---

## Live Cloud Run Deployments

| Microservice | Route | Live URL |
| :--- | :--- | :--- |
| **Frontend BFF — Login Page** | `/login` | [`https://chat-system-frontend-ayf6osu6ka-uc.a.run.app/login`](https://chat-system-frontend-ayf6osu6ka-uc.a.run.app/login) |
| **Frontend BFF — Chatting Page** | `/chat` | [`https://chat-system-frontend-ayf6osu6ka-uc.a.run.app/chat`](https://chat-system-frontend-ayf6osu6ka-uc.a.run.app/chat) |
| **Backend Microservices Gateway** | `/v1/health` | [`https://chat-system-backend-ayf6osu6ka-uc.a.run.app/v1/health`](https://chat-system-backend-ayf6osu6ka-uc.a.run.app/v1/health) |

---

## Visual Architecture Overview

### 1. End-to-End System Architecture & Message Delivery Flow
![End-to-End System Architecture](./docs/diagrams/end-to-end-architecture.svg)

### 2. Google Cloud Pub/Sub Two-Tier Hybrid Message Routing Topology
![Pub/Sub Message Routing Topology](./docs/diagrams/pubsub-routing-topology.svg)

### 3. Connection, Authentication & Presence Lifecycle
![Connection Lifecycle Sequence Diagram](./docs/diagrams/connection-lifecycle.svg)

### 4. Frontend Modular Architecture & WebSocket State Machine
![Frontend Architecture & WebSocket State Machine](./docs/diagrams/frontend-architecture.svg)

---

## Repository Structure

```text
chat-system/
├── README.md                          # Overview, Specification Reference & Testing Guide
├── firebase.json                      # Firestore configuration
├── firestore.rules                    # Production-hardened Firestore Security Rules
├── firestore.indexes.json             # Composite indexes for Firestore Native Mode
├── docs/                              # Architecture & Design Specifications
│   ├── 01-high-level-architecture.md  # HLA Blueprint, SLO Matrix & Capacity Estimation
│   ├── 02-backend-design-specification.md  # REST/WS APIs, Spanner DDL, Firestore & Pub/Sub
│   ├── 03-frontend-design-specification.md # Micro-Frontend Architecture, Store & Security
│   ├── architecture.dot               # Graphviz DOT source
│   └── diagrams/                      # Rendered SVG architecture & sequence diagrams
├── backend/                           # Backend Microservices Gateway (Cloud Run)
│   ├── src/
│   │   ├── index.ts                   # Auth, Channels, Messages, Presence & WS Gateway
│   │   ├── config/security.ts         # Scrypt, HS256 JWT, CSP Nonce, PII Masking & Cookies
│   │   ├── repositories/
│   │   │   ├── database.repository.ts # Dual-Write/Read Cloud Spanner & Cloud Firestore
│   │   │   └── ephemeral-store.ts     # Single-Use WS Tickets, Presence & Typing Store
│   │   └── public/                    # Static fallback assets
│   ├── scripts/
│   │   ├── seed.ts                    # Database seeding script (Spanner + Firestore)
│   │   └── test-e2e.ts                # 7-Part Backend & Database E2E Test Suite
│   └── tests/
│       └── backend.unit.test.ts       # 8-Part Backend Cryptographic & Store Unit Tests
└── frontend/                          # Frontend BFF & Two-Page Web Client (Cloud Run)
    ├── src/
    │   ├── server.ts                  # Express BFF Proxy, WS Relay & Per-Request CSP Nonces
    │   ├── domain/
    │   │   ├── chat-store.ts          # Normalized State Store & Optimistic Outbox Reconciler
    │   │   ├── ws-state-machine.ts    # Deterministic WebSocket FSM & Full-Jitter Backoff
    │   │   └── security-sanitizer.ts  # PII Masking & Media Attachment Validator
    │   └── public/
    │       ├── login.html             # Dedicated Login & Registration Page (/login)
    │       ├── login.js               # Login, Registration & 1-Click Demo Persona Logic
    │       ├── index.html             # Dedicated Real-Time Chatting Workspace (/chat)
    │       └── app.js                 # Real-Time Chat Client, Outbox & DB Switcher
    ├── scripts/
    │   └── test-frontend-e2e.ts       # 6-Part Frontend UI, Store & BFF E2E Test Suite
    └── tests/
        └── frontend.unit.test.ts      # 13-Part Frontend Domain & Security Unit Tests
```

---

## Architecture & Design Documentation Index

1. **[01-high-level-architecture.md](./docs/01-high-level-architecture.md)**
   - Executive Summary & SLO Matrix (`<200ms` latency, `99.99%` availability, `1M` concurrent connections)
   - Microservices Decomposition Principles (Bounded Contexts, Stateless vs. Stateful Edge Separation, Database-per-Service)
   - Embedded SVG + Interactive Mermaid + Vertical Graphviz (`dot`) End-to-End Architecture Diagram & 10-Step Message Delivery Flow
   - Capacity & Resource Estimation (Memory, Bandwidth, Storage Growth)
   - Mandatory Security Architecture & Verification Plan
2. **[02-backend-design-specification.md](./docs/02-backend-design-specification.md)**
   - **Task 1 — API Design**: Core REST API Endpoints (`/v1/auth/*`, `/v1/channels/*`, `/v1/presence/*`) and Bidirectional WebSocket Event Payloads (`send_message`, `message_ack`, `receive_message`, `typing_indicator`, `presence_update`, `read_receipt`, `heartbeat_ping`)
   - **Task 2 — Database Schema**: Cloud Spanner DDL (with `INTERLEAVE IN PARENT` locality), Firestore Native Mode collection hierarchy, and Ephemeral routing/presence structures
   - **Task 3 — Message Routing Topology**: Two-Tier Hybrid Google Cloud Pub/Sub topology (`chat-node-{pod_uid}` unicast/multicast topics + `channel-broadcast-shard-{0..63}` large room fan-out)
   - **Task 5 — Connection Lifecycle**: End-to-End Sequence Diagram and walkthrough for authentication, single-use WebSocket ticket redemption, session registration, 30s heartbeat loop, and presence broadcasting
3. **[03-frontend-design-specification.md](./docs/03-frontend-design-specification.md)**
   - Clean Modular & Micro-Frontend Architecture (`@chat/app-shell`, `@chat/auth-session`, `@chat/channel-roster`, `@chat/messaging-core`, `@chat/presence-typing`, `@chat/media-uploader`)
   - Two-Page User Interface: Dedicated **Login Page (`/login`)** and **Chatting Page (`/chat`)**
   - Real-Time WebSocket Client Engine (Connection State Machine, Exponential Backoff with Full Jitter, Zombie Socket Detection, Sequence Gap Delta Sync)
   - Normalized State Store, Optimistic UI Reconciliation (`<16ms` perceived send latency), and `content-visibility: auto` Timeline Rendering

---

## Running Unit & End-to-End Tests

### 1. Frontend Unit & E2E Tests
```bash
cd frontend
npm run test:unit   # Runs 13 unit tests (Store, WS State Machine, PII Sanitizer, Static Security)
npm run test:e2e    # Runs 6 E2E tests against the deployed Frontend BFF (/login, /chat, WS Relay)
```

### 2. Backend Unit & E2E Tests
```bash
cd backend
npm run test:unit   # Runs 8 unit tests (Scrypt, HS256 JWT, Single-Use WS Tickets, Presence)
npm run test:e2e    # Runs 7 E2E tests against Cloud Spanner, Cloud Firestore & WebSocket Gateway
```

---

## Security & Secret Hygiene Verification

- **Zero Committed Secrets or Passwords**: No hardcoded passwords, API keys, JWT signing secrets, or service account private keys are stored in this repository. Ephemeral or environment-injected credentials (`process.env.JWT_SECRET`, `process.env.CHAT_SEED_PASSWORD`, Application Default Credentials) are used at runtime.
- **SQL Injection Prevention**: 100% of Cloud Spanner queries use parameterized `@param` bindings.
- **DOM XSS Prevention**: Zero occurrences of `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write` across both `/login` and `/chat`.
- **Session & Token Hardening**: Authentication tokens are stored in `HttpOnly; Secure; SameSite=Lax` `__Host-chat_session` cookies, and CSRF tokens are held strictly in JavaScript memory (`0` tokens in `localStorage` or `sessionStorage`).
