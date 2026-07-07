# Guard Tech Solutions — Project Handoff

**Prepared:** June 29, 2026 | **Version:** 1.0 | **Project:** KM-GTS

---

## 1. Executive Summary

Guard Tech Solutions (KM-GTS) is a Houston-based security guard company owned by Kenrick M. The project is a fully custom digital operations platform that replaces third-party tools (Connecteam for time-clocking, spreadsheets for CRM) with a single, self-hosted web application deployed on Netlify.

The platform consists of a public-facing marketing website (`index.html`), a staff/admin portal (`portal.html`), and three serverless API functions. Together they handle lead generation, CRM pipeline management, employee time-tracking with GPS geofencing, AI-assisted outreach drafting, and owner approval workflows.

### Business Context

- **Company:** Guard Tech Solutions — licensed security guard provider serving the Greater Houston metro area (Harris, Fort Bend, Brazoria, Montgomery counties).
- **Services:** Armed & unarmed guards, mobile patrol, event security, full security management for commercial properties, multifamily, retail, HOAs, faith organizations, schools, and construction sites.
- **Target market:** Commercial property managers, HOA managers, facilities directors, GMs — the gatekeepers who control the security vendor buy.
- **Domain:** guardtechsolutions.com (marketing site served via Netlify at km-gts.netlify.app).

---

## 2. System Architecture

### 2.1 Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Single-file HTML + vanilla JS + CSS (no framework, no build step) |
| Backend | Netlify Functions (serverless Node.js — ESM modules) |
| Database | Netlify Blobs (key-value JSON store, strong consistency) |
| Hosting | Netlify CDN (site ID: `af91fa35-06bf-436f-b3f8-d05747750473`) |
| AI Agent | Anthropic Claude API (`claude-sonnet-4-6`) via agent.mjs function |
| Maps | Leaflet.js + OpenStreetMap tiles (no API key required) |
| Fonts | Google Fonts: Inter (body), Syne (headings), Oswald (accents) |
| Auth | Password-based (`x-gts-pw` header) + employee PIN-based login |

### 2.2 File Structure

| File / Directory | Purpose |
|-----------------|---------|
| `index.html` | Public marketing website — SEO-optimized landing page with services, coverage areas, contact form, structured data (JSON-LD) |
| `portal.html` | Staff & admin portal — the core application (~2,400 lines). Login, clock-in/out, CRM, scheduling, payroll, approvals, AI agent chat |
| `netlify/functions/crm.mjs` | Cloud CRM API — reads/writes leads to Netlify Blobs. Supports admin + owner auth, seed/merge route |
| `netlify/functions/time.mjs` | Cloud time-clock API — GPS-verified punches, geofence enforcement, shift/site management, timesheet review |
| `netlify/functions/agent.mjs` | AI CRM agent — Claude-powered conversational tool-use agent for pipeline management |
| `netlify/functions/seed-leads.json` | 30 canonical leads — Houston commercial PMs scored 60+ for initial pipeline seeding |
| `lead-gen/` | Lead generation assets: CSVs, outreach scripts, email campaigns, LinkedIn playbooks, import scripts. NOT deployed (gitignored) |
| `docs/` | Company documents (PDFs) served at `/docs/*` — e.g., GTS Capability Overview |
| `deploy.ps1` | PowerShell deployment script — stages files to `_publish/`, bumps version, runs `netlify deploy --prod` |
| `seed-live.mjs` | One-time script to merge seed leads into the live CRM (dry-run by default, `--commit` to write) |
| `guard-tech-*.svg/png` | Brand assets — logo, icon, dark variant |
| `.gitignore` | Excludes node_modules, .env, .netlify, _publish, all .xlsx/.csv, and lead-gen/ from version control |

### 2.3 Data Flow

The portal uses `localStorage` as a local cache and syncs bidirectionally with Netlify Blobs via the serverless functions. CRM leads auto-push to the cloud on every edit (600ms debounce). Time-clock data is server-authoritative — all punches mutate server-side to prevent concurrent guard conflicts. The portal polls `version.json` for auto-reload after deploys.

---

## 3. Portal Features (portal.html)

The portal serves three user roles, each with distinct views and permissions.

### 3.1 Roles & Authentication

| Role | Auth Method | Access |
|------|------------|--------|
| Employee (Guard) | Select name + 4-digit PIN | Clock in/out, view own hours/schedule, see upcoming shifts |
| Admin (Operator) | Password (`GTS_ADMIN_PW` env var) | Full CRM, team timesheets, schedule management, site geofencing, officer CRUD, AI agent, documents |
| Owner (Kenrick M.) | Password (`GTS_OWNER_PW` env var) | Executive dashboard, pipeline pulse, approval center (email drafts + timesheets), payroll report, documents |

### 3.2 Time Clock & Employee Management

**Clock In/Out**

- Guards select their name from a roster (fetched from server) and enter their 4-digit PIN.
- GPS location is captured on every punch (clock-in, break start/end, clock-out).
- Server-side geofence enforcement: if the guard is outside the post's configured radius, the punch is rejected with distance feedback.
- Break tracking with auto-close on clock-out if a break was left open.
- Offline fallback: if server is unreachable, punches are recorded locally (flagged for review).

**Geofence & Site Management**

- Admins configure sites with GPS coordinates and a geofence radius (default 150m).
- Interactive Leaflet map in the site config modal: draggable gold pin, live geofence circle, auto-fill from current location.
- Haversine distance calculation with GPS accuracy grace (capped at 100m) to avoid false rejections.
- Punches at ungeofenced sites are allowed but auto-flagged for admin review.

**Overtime & Payroll**

- Weekly hours calculated with 40-hour OT threshold; overtime at 1.5x base rate.
- Guard view: Regular hours, OT hours, and estimated gross pay cards.
- Admin officer table: per-officer OT badges and gross pay estimates.
- Payroll Report page: weekly/biweekly toggle, period navigation, summary KPIs, full breakdown table with regular/OT/gross per officer and totals row.

**Timesheet Filtering & Review**

- Filter controls on all time-entry views: date range, officer, site, status (active/pending/approved/flagged/rejected).
- Approval queue surfaces pending + flagged entries for admin/owner sign-off before billing.
- Approve/reject individual entries; status flows: pending → approved/rejected/flagged.

### 3.3 CRM & Lead Pipeline

**Pipeline Stages:** New → Contacted → Demo Sent → Proposal → Won / Lost.

- Data-table view with sortable columns: company, contact, stage, value, score, next step, due date, last activity.
- Smart filters: all open, hot leads (high score + soon due), stale (no activity 7+ days), needs email, by stage.
- Inline stage changes and next-step updates directly from the table.
- Lead detail drawer: full contact info, editable fields, notes timeline, agent action status, LinkedIn profile link.
- Cold-call script generator for leads without email on file.

**HITL Action Pipeline (Human-in-the-Loop)**

- Each stage maps to an agent action (e.g., New → LinkedIn intro, Contacted → follow-up message, Proposal → pricing).
- When a lead changes stage, it's flagged `actionStatus='pending'` for the AI agent.
- Agent drafts the outreach artifact; status moves to `'ready'` for user review.
- Owner approval required before sending: approve to send or send back for revision.
- Status chain: `pending` (agent to do) → `ready` (review/send) → `approved` (owner OK) → `done`.

**AI CRM Agent (Chat)**

- Conversational agent powered by Claude (`claude-sonnet-4-6`) via the `agent.mjs` serverless function.
- Tool-use capabilities: `add_lead`, `update_lead`, `move_stage`, `delete_lead`, `add_note`, `open_tab` (browser research).
- System prompt includes the full live pipeline state; the agent can make direct CRM edits.
- Max 6 tool-use turns per request; 20-message history window.
- Human-in-the-loop: agent drafts outreach but never sends messages/email directly.

**Lead Scoring & Segmentation**

- Leads scored 0–100 based on: title authority (0–25), property-type guard demand (0–30), portfolio size (0–20), service area (0–15), buying signal (0–10).
- Auto-segmentation by specialty: Multifamily, Retail, Office, Industrial, HOA, Faith/Church, Construction, Mixed/Other.

### 3.4 Owner Views

- **Executive Overview:** on-duty count, pipeline value, closed/won revenue, weekly payroll estimate, recent activity feed.
- **Pipeline Pulse:** prioritized lead cards (soonest/overdue first), new leads this week, approval call-outs.
- **Approval Center:** email drafts awaiting OK + timesheets awaiting review, with approve/reject/send-back actions.
- **Payroll Report:** weekly/biweekly summaries with OT calculation.

### 3.5 Documents Library

Shared company documents served from `/docs/` (e.g., GTS Capability Overview PDF). Admin and owner roles can view/download.

---

## 4. Serverless API Reference

### 4.1 CRM Function (crm.mjs)

| Endpoint | Description |
|----------|-------------|
| `GET /` | Returns `{ leads:[], role }` — full lead array + which password matched (admin/owner) |
| `POST /` | Saves `{ leads:[] }` — full array replace (used by cloud sync) |
| `POST /?seed=1` | Merges 30 canonical leads from seed-leads.json. Dedupes by company\|contact. Never changes existing stages. Idempotent. |

**Auth:** Header `x-gts-pw` must match `GTS_ADMIN_PW` or `GTS_OWNER_PW` env vars.

**Storage:** Netlify Blobs store `gts-crm`, key `leads`.

### 4.2 Time-Clock Function (time.mjs)

| Route | Description |
|-------|-------------|
| `GET ?roster=1` | Public: returns employee names/titles for the login dropdown |
| `GET` (admin auth) | Full snapshot: employees, entries, shifts, sites |
| `POST action:login` | Guard auth with empId + PIN → returns own entries/shifts/sites |
| `POST action:punch` | Server-side clock in/out/break with GPS geofence enforcement |
| `POST action:review` | Admin: approve/reject/flag a time entry |
| `POST action:config` | Admin: replace employee/shift/site config arrays |

**Geofence logic:** Haversine distance check + GPS accuracy grace (capped 100m). Rejects punches outside post radius.

**Storage:** Netlify Blobs store `gts-time`, key `data`.

### 4.3 AI Agent Function (agent.mjs)

- **Model:** `claude-sonnet-4-6` (configurable in source).
- **Endpoint:** `POST /.netlify/functions/agent` with `{ messages, leads }` → returns `{ reply, leads, openTabs, actions }`.
- **Tools:** `add_lead`, `update_lead`, `move_stage`, `delete_lead`, `add_note`, `open_tab`.
- **Auth:** `x-gts-pw` header = `GTS_ADMIN_PW`.
- **Requires:** `ANTHROPIC_API_KEY` env var on the Netlify site.

---

## 5. Environment Variables & Credentials

These must be set in the Netlify site's environment variables (Site settings → Environment variables):

| Variable | Purpose |
|----------|---------|
| `GTS_ADMIN_PW` | Admin/operator login password. Used by CRM, time-clock, and agent functions. |
| `GTS_OWNER_PW` | Owner (Kenrick M.) login password. Grants access to owner views + approval center. |
| `ANTHROPIC_API_KEY` | Anthropic API key for the AI CRM agent. Required for agent.mjs to function. |

**Guard PINs:** 4-digit PINs stored in the time-clock Blob (employees array). Configured by admin via the portal. Demo PIN for all staff: `1234`.

**Netlify site ID:** `af91fa35-06bf-436f-b3f8-d05747750473`

**Netlify CLI auth:** Must be logged in via `netlify login` before running `deploy.ps1`.

---

## 6. Deployment

### 6.1 Deploy Process

Run from PowerShell in the project root:

```powershell
.\deploy.ps1
```

This script:

1. Stages public-safe files (index.html, portal.html, logos, docs/) into `_publish/`
2. Writes cache-busting `_headers` and `version.json`
3. Runs `netlify deploy --prod` (builds functions via esbuild, deploys to CDN)
4. Open portal tabs auto-reload within ~60 seconds via version polling

### 6.2 What Gets Deployed vs. What Stays Local

| Deployed (public) | Local only (private) |
|-------------------|---------------------|
| index.html, portal.html | Houston_Security_Leads.xlsx |
| guard-tech-*.svg/png | Houston_Security_Pipeline.xlsx |
| docs/ (PDFs) | Security_Business_Pipeline.xlsx |
| netlify/functions/*.mjs | lead-gen/ (CSVs, outreach, playbooks) |
| version.json, _headers | houston_mom_pop_commercial_pm.csv |

---

## 7. Lead Generation System

### 7.1 ICP (Ideal Customer Profile)

- **Titles:** Property Manager, Regional PM, Director of Operations/Facilities, Community Manager, Asset Manager, VP Ops.
- **Geography:** Houston +25mi (Pearland, Katy, Sugar Land, The Woodlands, Spring, Cypress, and surrounding).
- **Property types (ranked by guard demand):** Multifamily/apartments (highest), retail/shopping centers, Class A/B office, industrial/warehouse, HOA/gated, construction, medical campuses.
- **Disqualify:** residential realtors, out of service area, single-property landlords, existing CRM duplicates.

### 7.2 Pipeline

ICP → PULL (Apollo primary / LinkedIn fallback) → ENRICH (email, phone, property types) → SCORE (0–100, import ≥60) → portal CRM.

### 7.3 Outreach Assets (in lead-gen/)

- **outreach.md:** Core cold email, LinkedIn DM, and cold call scripts. Pain-led messaging (liability, no-shows, tenant complaints).
- **email-campaign-8wk.md:** 8-week nurture drip: alternating value/CTA emails. Tuesday 9 AM CT cadence.
- **playbooks/:** Channel-specific playbooks for cold-call, cold-email, and LinkedIn outreach.
- **connect-followup-dm.md:** LinkedIn connection acceptance follow-up templates.
- **outreach-batch-01.md:** First outreach batch with personalized messages per lead.
- **leads.csv:** Master lead list with 30 scored prospects (score, LinkedIn URL, property types, signals).

### 7.4 Seeding the CRM

Two methods to load seed leads into the live CRM:

- **Server-side:** POST to `/.netlify/functions/crm?seed=1` (merges seed-leads.json, dedupes, never overwrites stages).
- **Client-side:** `node seed-live.mjs` (dry-run first, then `--commit`). Requires `GTS_ADMIN_PW` env var.

---

## 8. Marketing Website (index.html)

- SEO-optimized single-page site targeting "security guard company Houston TX" and related keywords.
- Structured data: JSON-LD for SecurityService schema + FAQ schema (6 questions).
- Sections: hero with CTA, services grid, industries served, coverage areas (13 cities), about, contact form.
- Responsive design with mobile hamburger menu.
- Meta tags for Open Graph, Twitter Card, geo targeting (Houston, TX — 29.7604, -95.3698).
- Canonical URL: `https://www.guardtechsolutions.com/`

---

## 9. Known Issues & Technical Debt

1. **Single-file architecture:** portal.html is ~2,400 lines of HTML+CSS+JS in one file. Works well for a small team but will become unwieldy at scale. Consider a framework (React/Vue) and component split if the feature set grows significantly.

2. **Full-array CRM sync:** CRM saves overwrite the entire leads array. If two admins edit simultaneously, last-write-wins. Fine for a small team; add per-lead mutations (like time.mjs does) if concurrent editing becomes an issue.

3. **No export functionality:** Timesheets and payroll reports can't be exported to CSV/PDF yet. This was identified as a future enhancement.

4. **No password management UI:** Admin and owner passwords are set as Netlify env vars. There's no in-app password change flow.

5. **Agent cost:** Every CRM agent chat message costs an Anthropic API call. No rate limiting or cost tracking is built in.

---

## 10. Future Roadmap

- **CSV/PDF export:** Add download buttons for timesheets, payroll summaries, and CRM data.
- **Invoice generation:** Auto-generate client invoices from approved timesheets (client × hours × bill rate).
- **Guard mobile app:** PWA or native app for guards — push notifications for shift reminders, simplified clock-in.
- **Client portal:** Read-only view for security clients to see guard activity at their sites.
- **Automated email sending:** Currently drafts only; integrate with an email service (SendGrid, Resend) to send directly from the platform.
- **Multi-location expansion:** Support for operations outside Houston with per-region scheduling and CRM views.
- **Incident reporting:** Guards log incidents (with photos) from the portal; admin/owner review queue.
- **Shift bidding:** Guards can view and request open shifts; admin approves.

---

## 11. Quick Start for New Developers

### Prerequisites

- Node.js 18+
- Netlify CLI (`npm install -g netlify-cli`), authenticated via `netlify login`
- Git access to the KM-GTS repository

### Local Development

1. Clone the repo and `cd` into KM-GTS
2. `npm install` (installs @netlify/blobs for functions)
3. Set env vars: `GTS_ADMIN_PW`, `GTS_OWNER_PW`, `ANTHROPIC_API_KEY`
4. `netlify dev` (starts local server with functions at localhost:8888)
5. Open `localhost:8888/portal.html` — sign in with Admin role and your `GTS_ADMIN_PW`
6. Deploy: `.\deploy.ps1` from PowerShell

### Key URLs

| URL | Description |
|-----|-------------|
| https://km-gts.netlify.app/ | Marketing website (index.html) |
| https://km-gts.netlify.app/portal.html | Staff/admin portal |
| https://app.netlify.com/sites/km-gts | Netlify dashboard (deploys, env vars, functions logs) |

### Console API (window.GTS)

The portal exposes a `window.GTS` object for direct CRM manipulation from the browser console: `listLeads`, `getLead`, `upsertLead`, `updateLead`, `addNote`, `setStage`, `setNextStep`, `bulkUpsert`, `exportJSON`, `importJSON`, `stats`, `help`.
