# Product Owner AI

Product Owner AI is a Chrome extension and Node.js API for consultancy Agile teams. It creates a product pack from meeting notes, documents, and connected project systems.

## Run locally

1. Install Node.js 20 or later and run `npm ci`.
2. Copy `.env.example` to `.env`. Set a private `APP_SECRET` (for example, generate one with `openssl rand -base64 48`) and add the service credentials you have configured.
3. Run `npm start`. The account page is at `http://localhost:3000`.
4. Open `chrome://extensions`, enable Developer mode, and load `extension/` as an unpacked extension.

The API creates `.data/product-owner-ai.sqlite` and a development secret when run locally. Keep `.data` private and backed up. In production, set `NODE_ENV=production`, a unique `APP_SECRET`, an HTTPS `PUBLIC_BASE_URL`, the production OAuth callback URLs, and the exact Chrome extension origin in `EXTENSION_ORIGIN`. Do not expose this app publicly with an example or missing secret.

## Authentication and workspaces

- Google OpenID Connect sign-in supports personal and work Google accounts, subject to Google consent-screen policy. Atlassian sign-in uses the user's Atlassian Cloud account and requires the `read:me` scope. These identity providers create private workspaces.
- OAuth uses one-time state, PKCE where supported, verified provider identities, hashed opaque sessions, CSRF validation, and HTTP-only cookies. Provider access/refresh tokens and project documents are encrypted with AES-256-GCM; session tokens are stored as hashes.
- Workspace owners can create additional workspaces and issue one-time, optionally email-restricted invitation tokens. Members switch workspaces from the extension. Provider identities with matching email are deliberately not silently merged.
- Organization memberships have Company Admin, Product Owner, Scrum Master, and Head of Product roles. Company Admins manage invitations, billing, and role assignments; Scrum Masters can manage stand-up schedules; Company Admins and Heads of Product can review usage telemetry.
- Google Drive/Calendar, Atlassian Jira/Confluence, Slack, Zoom, and Microsoft integrations are connected separately to a workspace.

## OAuth provider setup

Register these exact redirect URLs with each provider and set the matching credentials in `.env`:

- Google OAuth Web application: `http://localhost:3000/auth/google/callback` for local development. Request `openid`, `email`, `profile`, Drive read-only, and Calendar events scopes. For production, use the deployed HTTPS URL.
- Atlassian OAuth 2.0 (3LO): `http://localhost:3000/auth/atlassian/callback`. Enable identity, Jira read/write, Confluence read/write, and offline access scopes. Atlassian requires a public HTTPS callback for a distributable production integration.
- Slack OAuth v2: `/auth/slack/callback`; configure bot scopes `chat:write`, `im:write`, `im:read`, `im:history`, and `users:read`. Set the signing secret. Enable the Events API request URL `https://<host>/api/webhooks/slack` and subscribe to bot `message.im` events for stand-up replies. Slack requires HTTPS even during development; use an HTTPS development tunnel and set `PUBLIC_BASE_URL` accordingly.
- Zoom OAuth: `/auth/zoom/callback`; grant user profile and cloud-recording/transcript read scopes.
- Microsoft Entra ID: `/auth/microsoft/callback`; configure a supported account type and delegated `User.Read`, `Calendars.ReadWrite`, `OnlineMeetings.Read`, and `OnlineMeetingTranscript.Read.All` permissions. Meeting transcript access may require tenant admin consent and depends on Microsoft licensing/policy.

Callback URLs must use the same scheme, host, port, and path configured in the provider console. The locally loaded extension ID can be found at `chrome://extensions`; set its full origin as `EXTENSION_ORIGIN` for a production deployment.

## Implemented features

- Product, Engineering, QA, and Delivery/Risk agents generate stories, acceptance criteria, SAFe planning proposals, BRD/PO documentation, Mermaid source, test cases, roadmap, risks, and project status.
- Workspace sign-in supports Google and Atlassian OAuth plus local email/password registration and sign-in for teams that prefer direct credentials.
- Users can manage external provider credentials for Jira, OpenAI, Gemini, Microsoft Copilot, Figma, and Google Drive from the profile page, with those secret values encrypted before storage.
- Projects and uploaded text/transcript documents persist inside a workspace; their content and generated packs are encrypted at rest. Uploads support text, Markdown, CSV, JSON, logs, VTT, SRT, PDF, DOCX, and XLSX, up to 2 MB per file; PDF uploads are limited to 150 pages, Office archives are screened against excessive expansion, and scanned PDFs require OCR before upload.
- Jira issue search, Confluence search, Jira comments, and Google Drive text/Google Docs import use workspace-scoped OAuth connections. A Jira comment from the extension requires a deliberate click and confirmation.
- Zoom cloud transcript and Teams transcript import are available when provider scopes allow them. Teams transcript import currently requires the online-meeting ID to be supplied.
- Agenda drafts can be reviewed and explicitly scheduled as Google Calendar/Meet or Microsoft Teams events. Attendee invitations are sent only after confirmation.
- Workspace admins can schedule daily Slack DM check-ins for selected members. A reply to the check-in thread is recorded; if the admin configured a Jira site and issue, the reply is posted as a Jira comment. Disable the issue selection to keep replies in the workspace only.
- Billing has two AI paths: BYOK uses a fixed monthly platform subscription (`STRIPE_PRICE_BYOK`) and the user's saved OpenAI key; managed AI uses prepaid credits (`STRIPE_PRICE_MANAGED_CREDITS`) and debits exact prompt/completion token usage with a configurable markup. The managed Stripe price must be a one-time USD price whose value matches `MANAGED_CREDIT_PACK_MICRO_USD`. The older Team/Business/metered billing endpoints remain for existing subscriptions during migration.
- Users can add an OpenAI API key to their encrypted profile for BYOK generation. A request-scoped key can also be supplied by API clients and is not retained.

Every OpenAI generation stores the workspace, user, provider, model, exact input/output/total token counts, cost basis, and billable amount in `llm_usage`. Managed requests reserve a worst-case estimated amount before calling the model, are rejected when available credits are insufficient, and settle against actual returned token usage. Usage reports are available from `/api/billing/usage`; Company Admins and Heads of Product can access the per-generation records through `/api/admin/llm-usage`. Configure input/output cost basis with `LLM_INPUT_COST_MICRO_USD_PER_MILLION` and `LLM_OUTPUT_COST_MICRO_USD_PER_MILLION`, optional model-specific overrides with `LLM_MODEL_PRICING_JSON`, customer markup with `MANAGED_LLM_MARKUP_BPS`, and the model output cap with `MANAGED_MAX_OUTPUT_TOKENS`.

## Remaining provider/production prerequisites

The provider apps, callback URLs, tenant consent, Stripe products/webhooks, and deployed HTTPS host must be configured by the operator; this repository cannot create or approve those external accounts. For the new billing paths create a fixed monthly USD subscription price for BYOK and a one-time USD price for managed credits, configure their IDs and matching credit amount, and subscribe the signed webhook endpoint to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `customer.subscription.*`. Stripe signatures are verified against the raw request body and event IDs are persisted transactionally to make webhook processing idempotent. Secrets are injected through environment variables and can be sourced from a deployment secret manager; never use the example values as production secrets.

Authentication endpoints and LLM generation endpoints use persistent SQLite fixed-window rate limits, and HTTP failures are logged as structured JSON with request IDs. The limiter and current SQLite persistence are appropriate for a single app deployment; horizontally scaled production should move to shared PostgreSQL and a distributed limiter, with managed KMS secrets, monitoring, email delivery, data-export/deletion tooling, and backups before handling regulated/client-confidential data. The Python `app/` directory remains Celery/logging scaffolding; the active API and transaction paths are implemented in the existing Node.js service, not a parallel Python API.

The app does not capture or record live audio from Teams/Zoom, ingest Slack meeting conversations, run a Teams proactive notification bot, or automatically detect stale Jira stories or unresolved Jira comments. Zoom and Teams transcript retrieval is on-demand rather than continuously watched. Slack schedules run as a single-process timer. Teams bot installation/proactive messaging is separate from Microsoft OAuth and still requires a Bot Framework app and tenant deployment.

SAFe objectives/WSJF candidates and AI roadmap/risk outputs are suggestions based on supplied context; review them before treating them as commitments or live status.

## Tests

Run `npm test` for unit and HTTP tests, `npm run smoke` for JavaScript syntax checks, and `npm audit --omit=dev` for the production dependency audit.
