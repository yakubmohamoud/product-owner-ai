require('dotenv').config();

const express = require('express');
const cors = require('cors');
const XLSX = require('@e965/xlsx');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch {}
const {
  db,
  publicBaseUrl,
  createAuthorization,
  consumeOAuthState,
  exchangeCode,
  loadProfile,
  findOrCreateAccount,
  finalizeOAuthLogin,
  storeIntegration,
  authenticate,
  requireAuthentication,
  requireCsrf,
  getCurrentAccount,
  createWorkspace,
  listOrganizationMembers,
  updateOrganizationMemberRole,
  organizationRoles,
  issueInvitation,
  acceptInvitation,
  registerLocalUser,
  loginLocalUser,
  writeUserCredentials,
  readUserCredentials,
  deleteUserCredentials,
  clearCookieHeader,
  createId
} = require('./services/authService');
const {
  orchestrateArtifacts,
  createRequestAgentClient,
  answerProductQuestion,
  generateMeetingAgenda
} = require('./services/agentOrchestrator');
const { buildStandupDraft } = require('./services/teamWorkflowService');
const { createRateLimiter } = require('./services/rateLimitService');
const { log, logError } = require('./services/logger');
const projectService = require('./services/projectService');
const documentService = require('./services/documentService');
const integrationService = require('./services/integrationService');
const {
  getStripe,
  createCheckoutSession,
  createBillingPortal,
  processStripeEvent,
  recordUsage,
  drainBillingOutbox,
  getBillingAccount,
  estimateManagedReservation,
  reserveManagedCredits,
  recordLlmUsage,
  releaseManagedReservation,
  setBillingMode,
  getLlmUsage,
  createManagedCreditsCheckout,
  getManagedCreditConfig,
  cleanupExpiredReservations
} = require('./services/billingService');
const standupService = require('./services/standupService');

const app = express();
const port = process.env.PORT || 3000;
const authenticationRateLimit = createRateLimiter({
  name: 'authentication',
  windowMs: 15 * 60 * 1000,
  maxRequests: Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20', 10)
});
const generationRateLimit = createRateLimiter({
  name: 'llm_generation',
  windowMs: 60 * 1000,
  maxRequests: Number.parseInt(process.env.LLM_RATE_LIMIT_MAX || '30', 10)
});

app.set('trust proxy', process.env.TRUST_PROXY === 'true');
const allowedOrigins = new Set([
  publicBaseUrl(),
  ...(process.env.EXTENSION_ORIGIN ? [process.env.EXTENSION_ORIGIN] : [])
]);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function withAuthResult(returnTo, key, value) {
  const target = new URL(returnTo || '/', publicBaseUrl());
  target.searchParams.set(key, value);
  return `${target.pathname}${target.search}`;
}

function recordRequestUsage(req, res, eventType, units, billable) {
  const id = recordUsage(
    req.auth.organization_id,
    req.auth.user_id,
    eventType,
    units,
    billable,
    billable ? 'platform' : req.billingMode || 'byok'
  );
  const meterEvent = db.prepare('SELECT status FROM billing_outbox WHERE usage_event_id = ?').get(id);
  if (meterEvent?.status === 'pending') res.setHeader('X-Usage-Metering', 'queued');
  void drainBillingOutbox().catch((error) => logError('stripe_usage_metering_failed', error, {
    request_id: req.requestId
  }));
  return id;
}

function requireOrganizationRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.auth || !allowedRoles.includes(req.auth.organization_role)) {
      return res.status(403).json({ error: 'Your organization role does not permit this action.' });
    }
    return next();
  };
}

function getStoredOpenAiKey(userId) {
  return readUserCredentials(userId)
    .find((credential) => credential.provider === 'openai')
    ?.values?.api_key || null;
}

function createTrackedAgentClient(req) {
  return createRequestAgentClient(req.agentApiKey, (usage) => recordLlmUsage(
    req.auth.organization_id,
    req.auth.user_id,
    req.requestId,
    req.billingMode,
    usage
  ));
}

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) ||
      (process.env.NODE_ENV !== 'production' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin))) {
      return callback(null, true);
    }
    return callback(new Error('This browser origin is not allowed by the API.'));
  },
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});
app.use(express.json({
  limit: process.env.REQUEST_BODY_LIMIT || '120mb',
  verify(req, _res, buffer) {
    if (req.originalUrl === '/api/billing/webhook' || req.originalUrl === '/api/webhooks/slack') {
      req.rawBody = Buffer.from(buffer);
    }
  }
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'");
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use((req, res, next) => {
  const started = Date.now();
  res.once('finish', () => {
    if (res.statusCode >= 500) {
      log('error', 'http_request_failed', {
        request_id: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - started
      });
    }
  });
  next();
});
app.use(authenticate);
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false, fallthrough: true }));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

function getMonthlyUsage(organizationId) {
  return db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN billable = 1 THEN units ELSE 0 END), 0) AS billable_units,
      COALESCE(SUM(units), 0) AS total_units
    FROM usage_events WHERE organization_id = ? AND created_at >= ?
  `).get(
    organizationId,
    new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
  );
}

function enforceUsage(req, res, next) {
  const { apiKey } = req.body || {};
  if (apiKey !== undefined && apiKey !== null && apiKey !== '') {
    if (typeof apiKey !== 'string' || apiKey.length > 512 || !apiKey.trim()) {
      return res.status(400).json({ error: 'A provided API key must be a non-empty string under 512 characters.' });
    }
  }
  const account = getBillingAccount(req.auth.organization_id);
  req.billingMode = apiKey ? 'byok' : account.mode;
  req.agentApiKey = apiKey || null;
  if (req.billingMode === 'byok') {
    const subscription = db.prepare(`
      SELECT plan, status FROM subscriptions WHERE organization_id = ?
    `).get(req.auth.organization_id);
    if (subscription?.plan !== 'byok' || !['active', 'trialing'].includes(subscription.status)) {
      return res.status(402).json({ error: 'An active BYOK platform subscription is required.' });
    }
    req.agentApiKey = req.agentApiKey || getStoredOpenAiKey(req.auth.user_id);
    if (!req.agentApiKey) {
      return res.status(402).json({ error: 'Add your OpenAI API key in your profile to use BYOK billing.' });
    }
  } else {
    if (!process.env.OPENAI_API_KEY) {
      req.agentApiKey = null;
      return next();
    }
    const requestTextLength = ['text', 'context', 'question']
      .map((field) => req.body?.[field])
      .filter((value) => typeof value === 'string')
      .reduce((length, value) => length + value.length, 0);
    let textLength = requestTextLength;
    if (typeof req.body?.project_id === 'string') {
      const projectContext = projectService.assembleProjectContext(
        req.auth.organization_id,
        req.body.project_id,
        typeof req.body?.text === 'string' ? req.body.text : ''
      );
      if (!projectContext) return res.status(404).json({ error: 'Project not found in this workspace.' });
      textLength = Math.max(textLength, projectContext.context.length);
    }
    const callCount = req.path === '/api/generate' ? 4 : 1;
    try {
      reserveManagedCredits(
        req.auth.organization_id,
        req.auth.user_id,
        req.requestId,
        estimateManagedReservation(textLength, callCount)
      );
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          releaseManagedReservation(req.requestId, req.auth.organization_id);
        } catch (error) {
          logError('managed_credit_reservation_release_failed', error, {
            request_id: req.requestId,
            organization_id: req.auth.organization_id
          });
        }
      };
      res.once('finish', release);
    } catch (error) {
      return res.status(402).json({ error: error.message });
    }
  }
  return next();
}

app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe webhooks are not configured.' });
  }
  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.rawBody || req.body,
      req.get('stripe-signature'),
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    log('warn', 'stripe_webhook_signature_rejected', {
      request_id: req.requestId,
      message: error.message
    });
    return res.status(400).json({ error: 'Stripe webhook could not be validated or processed.' });
  }
  try {
    processStripeEvent(event);
    return res.json({ received: true });
  } catch (error) {
    logError('stripe_webhook_processing_failed', error, {
      request_id: req.requestId,
      event_id: event.id,
      event_type: event.type
    });
    return res.status(500).json({ error: 'Stripe webhook processing failed and can be retried.' });
  }
});

app.post('/api/webhooks/slack', (req, res) => {
  if (!standupService.verifySlackSignature(req)) {
    return res.status(401).json({ error: 'Slack request signature validation failed.' });
  }
  if (req.body?.type === 'url_verification' && typeof req.body.challenge === 'string') {
    return res.json({ challenge: req.body.challenge });
  }
  if (req.body?.type !== 'event_callback' || typeof req.body.event_id !== 'string') {
    return res.status(400).json({ error: 'Slack event payload is invalid.' });
  }
  standupService.processSlackEvent(req.body)
    .then(() => res.status(200).json({ ok: true }))
    .catch((error) => {
      logError('slack_standup_reply_processing_failed', error, {
        request_id: req.requestId,
        event_id: req.body.event_id
      });
      res.status(200).json({ ok: false, error: 'Reply was saved, but delivery or Jira posting needs review.' });
    });
});

app.get('/api/auth/providers', (_req, res) => {
  res.json({
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    atlassian: Boolean(
      (process.env.ATLASSIAN_CLIENT_ID || process.env.JIRA_CLIENT_ID) &&
      (process.env.ATLASSIAN_CLIENT_SECRET || process.env.JIRA_CLIENT_SECRET)
    ),
    slack: Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET),
    zoom: Boolean(process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET),
    microsoft: Boolean(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET),
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    prices: {
      byok: Boolean(process.env.STRIPE_PRICE_BYOK),
      managedCredits: Boolean(process.env.STRIPE_SECRET_KEY),
      team: Boolean(process.env.STRIPE_PRICE_TEAM),
      business: Boolean(process.env.STRIPE_PRICE_BUSINESS),
      payg: Boolean(process.env.STRIPE_PRICE_PAYG)
    },
    managedCreditConfig: getManagedCreditConfig()
  });
});

app.post('/api/auth/register', authenticationRateLimit, (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Please enter your full name.' });
    }
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const response = registerLocalUser(name, email, password, res);
    return res.status(201).json({
      user: { id: response.user.id, name: response.user.name, email: response.user.email },
      workspace: { id: response.organizationId },
      csrf_token: response.csrf
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', authenticationRateLimit, (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const response = loginLocalUser(email, password, res);
    return res.json({
      user: { id: response.user.id, name: response.user.name, email: response.user.email },
      workspace: { id: response.organizationId },
      csrf_token: response.csrf
    });
  } catch (error) {
    return res.status(401).json({ error: error.message });
  }
});

app.get('/api/profile/credentials', requireAuthentication, (req, res) => {
  try {
    const credentials = readUserCredentials(req.auth.user_id).map((credential) => {
      const secretFields = Object.keys(credential.values)
        .filter((field) => /key|token|secret|private|password|credential/i.test(field));
      const values = Object.fromEntries(Object.entries(credential.values)
        .filter(([field]) => !secretFields.includes(field)));
      return {
        provider: credential.provider,
        values,
        configured_secret_fields: secretFields,
        updated_at: credential.updated_at
      };
    });
    res.json({ credentials });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/profile/credentials', requireAuthentication, requireCsrf, (req, res) => {
  try {
    const provider = String(req.body?.provider || '').trim();
    const values = req.body?.values;
    if (!provider) return res.status(400).json({ error: 'Select a credential provider.' });
    const saved = writeUserCredentials(req.auth.user_id, provider, values);
    res.status(201).json({ credential: saved });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/profile/credentials/:provider', requireAuthentication, requireCsrf, (req, res) => {
  try {
    const result = deleteUserCredentials(req.auth.user_id, req.params.provider);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/auth/:provider/start', (req, res) => {
  try {
    const { provider } = req.params;
    const flow = req.query.flow === 'connect' ? 'connect' : 'login';
    const authorization = createAuthorization(provider, flow, req.auth, req.query.returnTo);
    res.setHeader('Set-Cookie', authorization.stateCookie);
    res.redirect(302, authorization.url);
  } catch (error) {
    res.status(400).send(`<p>${escapeHtml(error.message)}</p><a href="/">Back to sign in</a>`);
  }
});

app.get('/auth/:provider/callback', async (req, res) => {
  const { provider } = req.params;
  try {
    if (req.query.error) {
      throw new Error(`Sign-in was not completed (${String(req.query.error).slice(0, 80)}).`);
    }
    if (typeof req.query.code !== 'string' || typeof req.query.state !== 'string') {
      throw new Error('OAuth provider returned an incomplete callback.');
    }
    const transaction = consumeOAuthState(provider, req.query.state, req);
    const tokens = await exchangeCode(provider, req.query.code, transaction.verifier);
    const profile = await loadProfile(provider, tokens, transaction.nonce);

    if (transaction.flow === 'connect') {
      const currentUser = db.prepare('SELECT id FROM users WHERE id = ?').get(transaction.user_id);
      const currentMembership = db.prepare(
        'SELECT 1 FROM memberships WHERE organization_id = ? AND user_id = ?'
      ).get(transaction.organization_id, transaction.user_id);
      if (!currentUser || !currentMembership) throw new Error('Sign-in session expired. Restart integration setup.');
      const connectionTokens = { ...tokens };
      if (Number(tokens.expires_in) > 0) {
        connectionTokens.expires_at = Date.now() + Number(tokens.expires_in) * 1000;
      } else {
        delete connectionTokens.expires_at;
      }
      let metadata = {};
      if (provider === 'atlassian') {
        const sitesResponse = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
          headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(15000)
        });
        const sites = await sitesResponse.json();
        if (!sitesResponse.ok || !Array.isArray(sites)) {
          throw new Error('Atlassian could not list authorized sites. Check its Jira/Confluence permissions.');
        }
        metadata.sites = sites.map((site) => ({
          id: site.id,
          name: site.name,
          url: site.url,
          scopes: site.scopes || []
        }));
      }
      storeIntegration(
        transaction.organization_id,
        transaction.user_id,
        provider === 'google' ? 'google_drive' : provider,
        profile,
        connectionTokens,
        metadata
      );
      finalizeOAuthLogin(transaction.user_id, transaction.organization_id, res);
      return res.redirect(303, withAuthResult(transaction.return_to, 'connected', 'success'));
    }

    const { user, organizationId } = findOrCreateAccount(profile, provider);
    finalizeOAuthLogin(user.id, organizationId, res);
    res.redirect(303, withAuthResult(transaction.return_to, 'signed_in', 'success'));
  } catch (error) {
    logError('oauth_callback_failed', error, {
      provider,
      request_id: req.requestId
    });
    res.setHeader('Set-Cookie', clearCookieHeader('poai_oauth'));
    res.redirect(303, `/?auth_error=${encodeURIComponent(error.message || 'Sign-in failed.')}`);
  }
});

app.get('/api/auth/me', requireAuthentication, (req, res) => {
  const account = getCurrentAccount(req);
  account.integrations = db.prepare(`
    SELECT provider, external_account_id, display_name, email, connected_at, updated_at
    FROM integrations WHERE organization_id = ? ORDER BY provider
  `).all(req.auth.organization_id);
  account.usage = getMonthlyUsage(req.auth.organization_id);
  res.json(account);
});

app.post('/api/auth/logout', requireAuthentication, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.auth.tokenHash);
  res.setHeader('Set-Cookie', [
    clearCookieHeader('poai_session', 'None'),
    clearCookieHeader('poai_oauth')
  ]);
  res.status(204).end();
});

app.get('/api/workspaces', requireAuthentication, (req, res) => {
  const workspaces = db.prepare(`
    SELECT o.id, o.name, m.role AS platform_role, m.organization_role AS role FROM memberships m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = ? ORDER BY o.created_at
  `).all(req.auth.user_id);
  res.json({ workspaces });
});

app.post('/api/workspaces', requireAuthentication, requireCsrf, (req, res) => {
  try {
    const workspace = createWorkspace(req.body?.name, req.auth.user_id);
    res.status(201).json({ workspace });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/workspaces/current', requireAuthentication, requireCsrf, (req, res) => {
  const workspaceId = req.body?.workspace_id;
  const membership = db.prepare('SELECT 1 FROM memberships WHERE organization_id = ? AND user_id = ?')
    .get(workspaceId, req.auth.user_id);
  if (!membership) return res.status(403).json({ error: 'You are not a member of that workspace.' });
  db.prepare('UPDATE sessions SET organization_id = ? WHERE token_hash = ?')
    .run(workspaceId, req.auth.tokenHash);
  res.json({ workspace_id: workspaceId });
});

app.get('/api/workspaces/members', requireAuthentication, (req, res) => {
  if (!['company_admin', 'head_of_product'].includes(req.auth.organization_role)) {
    return res.status(403).json({ error: 'Only Company Admins and Heads of Product can view organization roles.' });
  }
  res.json({ members: listOrganizationMembers(req.auth.organization_id), roles: organizationRoles });
});

app.put(
  '/api/workspaces/members/:userId/role',
  requireAuthentication,
  requireCsrf,
  requireOrganizationRole('company_admin'),
  (req, res) => {
    try {
      const result = updateOrganizationMemberRole(
        req.auth.organization_id,
        req.params.userId,
        req.body?.role
      );
      res.json({ member: result });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

app.post('/api/workspaces/invitations', requireAuthentication, requireCsrf, requireOrganizationRole('company_admin'), (req, res) => {
  try {
    const { token, expires_at: expiresAt } = issueInvitation(
      req.auth.organization_id,
      req.auth.user_id,
      req.body?.email,
      req.body?.role || 'member'
    );
    res.status(201).json({
      token,
      accept_endpoint: '/api/workspaces/invitations/accept',
      expires_at: expiresAt,
      note: 'Share this one-time token with the invitee using a trusted channel.'
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/workspaces/invitations/accept', requireAuthentication, requireCsrf, (req, res) => {
  try {
    const workspace = acceptInvitation(req.body?.token, {
      id: req.auth.user_id,
      email: req.auth.email
    });
    res.json({ workspace });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/projects', requireAuthentication, (req, res) => {
  res.json({ projects: projectService.listProjects(req.auth.organization_id) });
});

app.post('/api/projects', requireAuthentication, requireCsrf, (req, res) => {
  try {
    const project = projectService.createProject(
      req.auth.organization_id,
      req.auth.user_id,
      req.body?.name,
      typeof req.body?.context === 'string'
        ? req.body.context
        : (typeof req.body?.notes === 'string' ? req.body.notes : '')
    );
    res.status(201).json({ project });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/projects/:projectId/context', requireAuthentication, (req, res) => {
  try {
    const result = projectService.assembleProjectContext(req.auth.organization_id, req.params.projectId);
    if (!result) return res.status(404).json({ error: 'Project not found in this workspace.' });
    res.json({ project: result.project, context: result.context });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/projects/:projectId/documents', requireAuthentication, (req, res) => {
  const documents = projectService.listDocuments(req.auth.organization_id, req.params.projectId);
  if (!documents) return res.status(404).json({ error: 'Project not found in this workspace.' });
  res.json({ documents });
});

app.delete('/api/projects/:projectId', requireAuthentication, requireCsrf, (req, res) => {
  try {
    const deleted = projectService.deleteProject(
      req.auth.organization_id,
      req.params.projectId,
      req.auth.user_id,
      req.auth.organization_role
    );
    if (!deleted) return res.status(404).json({ error: 'Project not found in this workspace.' });
    res.status(204).end();
  } catch (error) {
    res.status(403).json({ error: error.message });
  }
});

app.post('/api/projects/:projectId/documents', requireAuthentication, requireCsrf, (req, res) => {
  try {
    const document = projectService.addDocument(
      req.auth.organization_id,
      req.params.projectId,
      req.auth.user_id,
      req.body?.name,
      req.body?.content
    );
    res.status(201).json({ document });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/projects/:projectId/upload', requireAuthentication, requireCsrf, async (req, res) => {
  try {
    const { name, content_base64: encoded } = req.body || {};
    if (!projectService.getProject(req.auth.organization_id, req.params.projectId)) {
      return res.status(404).json({ error: 'Project not found in this workspace.' });
    }
    if (typeof encoded !== 'string' || encoded.length > 3 * 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      return res.status(400).json({ error: 'Document upload must contain valid base64 data under 2 MB.' });
    }
    const text = await documentService.extractText(name, Buffer.from(encoded, 'base64'));
    const document = projectService.addDocument(
      req.auth.organization_id,
      req.params.projectId,
      req.auth.user_id,
      name,
      text
    );
    res.status(201).json({ document });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/integrations', requireAuthentication, (req, res) => {
  const integrations = db.prepare(`
    SELECT provider, external_account_id, display_name, email, connected_at, updated_at, metadata
    FROM integrations WHERE organization_id = ? ORDER BY provider
  `).all(req.auth.organization_id).map((item) => ({
    ...item,
    metadata: JSON.parse(item.metadata || '{}')
  }));
  res.json({ integrations });
});

app.post('/api/requirements/classify', requireAuthentication, requireCsrf, (req, res) => {
  const transcript = typeof req.body?.transcript === 'string' ? req.body.transcript.trim() : '';
  if (!transcript || transcript.length > 500000) {
    return res.status(400).json({ error: 'Meeting transcript is required and must be under 500,000 characters.' });
  }
  const lower = transcript.toLowerCase();
  const bugSignals = /(crash|error|bug|incorrect|fails?|broken|unexpected|500|exception)/.test(lower);
  const epicSignals = /(programme|roadmap|quarter|multiple teams|strategic|epic|initiative)/.test(lower);
  const proposedType = bugSignals ? 'Bug' : epicSignals ? 'Epic' : 'Story';
  const required = proposedType === 'Bug'
    ? ['steps to reproduce', 'actual result', 'expected result', 'environment']
    : proposedType === 'Epic'
      ? ['business outcome', 'in scope', 'out of scope', 'target release']
      : ['actor / user role', 'desired outcome', 'acceptance criteria', 'priority'];
  const missing = required.filter((item) => !lower.includes(item) && !lower.includes(item.replace(' / ', ' ').replace(' / ', '')));
  const sentences = transcript.split(/[.!?\n]+/).map((value) => value.trim()).filter(Boolean).slice(0, 8);
  res.json({
    classification: { type: proposedType, confidence: proposedType === 'Story' ? 0.65 : 0.75 },
    summary: sentences.slice(0, 3).join('. '),
    missing_information: missing,
    sufficient_for_creation: missing.length === 0,
    next_questions: missing.map((item) => `Please clarify the ${item}.`)
  });
});

app.post('/api/meetings/transcribe-media', requireAuthentication, requireCsrf, async (req, res) => {
  try {
    if (!ffmpegPath) return res.status(503).json({ error: 'Meeting audio processing is unavailable because FFmpeg is not installed.' });
    const file = req.body?.file;
    if (!file?.data || !file?.name) return res.status(400).json({ error: 'Provide a base64 recording file and file name.' });
    const allowed = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a)$/i.test(file.name);
    if (!allowed) return res.status(400).json({ error: 'Supported recordings are MP4, MOV, M4V, WebM, MKV, AVI, MP3, WAV, and M4A.' });
    const buffer = Buffer.from(file.data, 'base64');
    if (!buffer.length || buffer.length > 100 * 1024 * 1024) return res.status(400).json({ error: 'Recording must be between 1 byte and 100 MB.' });
    const credentials = readUserCredentials(req.auth.user_id).find((entry) => entry.provider === 'openai');
    const apiKey = process.env.OPENAI_API_KEY || credentials?.values?.api_key;
    if (!apiKey) return res.status(402).json({ error: 'Configure an OpenAI API key to transcribe recordings.' });

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'poai-media-'));
    const input = path.join(directory, file.name.replace(/[^a-zA-Z0-9_.-]/g, '_'));
    const output = path.join(directory, 'audio.mp3');
    await fs.writeFile(input, buffer);
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', output], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('FFmpeg could not extract audio from the recording.')));
    });
    const audio = await fs.readFile(output);
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'audio.mp3');
    form.append('model', process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1');
    const transcription = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
      signal: AbortSignal.timeout(120000)
    });
    const payload = await transcription.json();
    await fs.rm(directory, { recursive: true, force: true });
    if (!transcription.ok) return res.status(502).json({ error: payload.error?.message || 'Recording transcription failed.' });
    res.json({ transcript: payload.text || '', file_name: file.name });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not process meeting recording.' });
  }
});

app.get('/api/integrations/atlassian/sites', requireAuthentication, async (req, res) => {
  try {
    const sites = await integrationService.listAtlassianSites(req.auth.organization_id);
    res.json({ sites });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/integrations/jira/issues', requireAuthentication, async (req, res) => {
  try {
    const result = await integrationService.searchJiraIssues(
      req.auth.organization_id,
      req.query.site_id,
      req.query.jql || ''
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/integrations/jira/issues/:issueKey/comments', requireAuthentication, requireCsrf, async (req, res) => {
  try {
    const result = await integrationService.addJiraComment(
      req.auth.organization_id,
      req.body?.site_id,
      req.params.issueKey,
      req.body?.text
    );
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/integrations/jira/issues', requireAuthentication, requireCsrf, async (req, res) => {
  try {
    const result = await integrationService.createJiraIssue(
      req.auth.organization_id, req.body?.site_id, req.body
    );
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/integrations/jira/issues/:issueKey', requireAuthentication, requireCsrf, async (req, res) => {
  try {
    const result = await integrationService.updateJiraIssue(
      req.auth.organization_id, req.body?.site_id, req.params.issueKey, req.body
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/integrations/confluence/pages', requireAuthentication, requireCsrf, async (req, res) => {
  try {
    const result = await integrationService.createConfluencePage(
      req.auth.organization_id, req.body?.site_id, req.body
    );
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/integrations/confluence/search', requireAuthentication, async (req, res) => {
  try {
    const results = await integrationService.searchConfluence(
      req.auth.organization_id,
      req.query.site_id,
      req.query.q || ''
    );
    res.json(results);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/integrations/google-drive/files', requireAuthentication, async (req, res) => {
  try {
    res.json({ files: await integrationService.listDriveFiles(req.auth.organization_id, req.query.q || '') });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/integrations/google-drive/import', requireAuthentication, requireCsrf, (req, res, next) => {
  Promise.resolve()
    .then(() => integrationService.getDriveDocumentText(req.auth.organization_id, req.body?.file_id))
    .then((document) => projectService.addDocument(
      req.auth.organization_id,
      req.body?.project_id,
      req.auth.user_id,
      document.name,
      document.content
    ))
    .then((document) => res.status(201).json({ document }))
    .catch(next);
});

app.get('/api/integrations/zoom/recordings', requireAuthentication, async (req, res) => {
  try {
    const recordings = await integrationService.listZoomRecordings(
      req.auth.organization_id,
      req.query.from,
      req.query.to
    );
    res.json({ recordings });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/integrations/zoom/import', requireAuthentication, requireCsrf, (req, res, next) => {
  Promise.resolve()
    .then(() => integrationService.getZoomTranscript(
      req.auth.organization_id,
      req.body?.meeting_id,
      req.body?.file_id
    ))
    .then((transcript) => projectService.addDocument(
      req.auth.organization_id,
      req.body?.project_id,
      req.auth.user_id,
      transcript.name,
      transcript.content
    ))
    .then((document) => res.status(201).json({ document }))
    .catch(next);
});

app.get('/api/integrations/microsoft/meetings/:meetingId/transcripts', requireAuthentication, async (req, res) => {
  try {
    const transcripts = await integrationService.listTeamsTranscripts(
      req.auth.organization_id,
      req.params.meetingId
    );
    res.json({ transcripts });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/integrations/microsoft/transcripts/import', requireAuthentication, requireCsrf, (req, res, next) => {
  Promise.resolve()
    .then(() => integrationService.getTeamsTranscript(
      req.auth.organization_id,
      req.body?.meeting_id,
      req.body?.transcript_id
    ))
    .then((transcript) => projectService.addDocument(
      req.auth.organization_id,
      req.body?.project_id,
      req.auth.user_id,
      transcript.name,
      transcript.content
    ))
    .then((document) => res.status(201).json({ document }))
    .catch(next);
});

app.post('/api/meetings/google-calendar', requireAuthentication, requireCsrf, (req, res) => {
  integrationService.createGoogleCalendarEvent(req.auth.organization_id, req.body)
    .then((event) => res.status(201).json(event))
    .catch((error) => res.status(400).json({ error: error.message }));
});

app.post('/api/meetings/teams', requireAuthentication, requireCsrf, (req, res) => {
  integrationService.createTeamsCalendarEvent(req.auth.organization_id, req.body)
    .then((event) => res.status(201).json(event))
    .catch((error) => res.status(400).json({ error: error.message }));
});

app.delete('/api/integrations/:provider/:externalAccountId', requireAuthentication, requireCsrf, (req, res) => {
  const provider = req.params.provider;
  if (!['atlassian', 'google_drive'].includes(provider)) {
    return res.status(400).json({ error: 'Unsupported integration.' });
  }
  const result = db.prepare(`
    DELETE FROM integrations
    WHERE organization_id = ? AND provider = ? AND external_account_id = ?
  `).run(req.auth.organization_id, provider, req.params.externalAccountId);
  if (result.changes === 0) return res.status(404).json({ error: 'Integration not found.' });
  res.json({ disconnected: true, note: 'The app removed its encrypted local tokens. Revoke access separately in the provider account settings.' });
});

app.get('/api/billing/plans', (_req, res) => {
  res.json({
    plans: [
      { id: 'byok', monthly_fee: true, price_configured: Boolean(process.env.STRIPE_PRICE_BYOK) },
      {
        id: 'managed',
        credit_based: true,
        price_configured: Boolean(process.env.STRIPE_PRICE_MANAGED_CREDITS),
        markup_basis_points: Number.parseInt(process.env.MANAGED_LLM_MARKUP_BPS || '3000', 10)
      },
      { id: 'free', monthly_units: 10, features: ['Personal workspace'] },
      { id: 'team', monthly_units: 500, price_configured: Boolean(process.env.STRIPE_PRICE_TEAM) },
      { id: 'business', monthly_units: 5000, price_configured: Boolean(process.env.STRIPE_PRICE_BUSINESS) },
      {
        id: 'payg',
        usage_billed: true,
        price_configured: Boolean(process.env.STRIPE_PRICE_PAYG && process.env.STRIPE_METER_EVENT_NAME)
      }
    ]
  });
});

app.post('/api/billing/checkout', requireAuthentication, requireCsrf, async (req, res) => {
  if (req.auth.organization_role !== 'company_admin') {
    return res.status(403).json({ error: 'Only Company Admins can change billing.' });
  }
  try {
    const workspace = { id: req.auth.organization_id, name: req.auth.organization_name };
    const user = { email: req.auth.email };
    res.json(await createCheckoutSession(workspace, user, req.body?.plan));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/billing/portal', requireAuthentication, requireCsrf, async (req, res) => {
  if (req.auth.organization_role !== 'company_admin') {
    return res.status(403).json({ error: 'Only Company Admins can manage billing.' });
  }
  try {
    res.json(await createBillingPortal(req.auth.organization_id));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/billing/credits/checkout', requireAuthentication, requireCsrf, async (req, res) => {
  if (req.auth.organization_role !== 'company_admin') {
    return res.status(403).json({ error: 'Only Company Admins can purchase managed API credits.' });
  }
  try {
    const organization = {
      id: req.auth.organization_id,
      name: req.auth.organization_name
    };
    const user = { email: req.auth.email };
    const amount = typeof req.body?.amount === 'number' ? req.body.amount : undefined;
    const currency = typeof req.body?.currency === 'string' ? req.body.currency : 'usd';
    res.json(await createManagedCreditsCheckout(organization, user, amount, currency));
  } catch (error) {
    logError('managed_credit_checkout_failed', error, { request_id: req.requestId });
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/billing/mode', requireAuthentication, requireCsrf, requireOrganizationRole('company_admin'), (req, res) => {
  try {
    const account = setBillingMode(req.auth.organization_id, req.body?.mode);
    res.json({
      mode: account.mode,
      balance_micro_usd: account.balance_micro_usd,
      reserved_micro_usd: account.reserved_micro_usd
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/billing/usage', requireAuthentication, (req, res) => {
  const subscription = db.prepare('SELECT plan, status FROM subscriptions WHERE organization_id = ?')
    .get(req.auth.organization_id);
  const account = getBillingAccount(req.auth.organization_id);
  const totals = getMonthlyUsage(req.auth.organization_id);
  const tokenUsage = db.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost_micro_usd), 0) AS cost_micro_usd,
      COALESCE(SUM(charged_micro_usd), 0) AS charged_micro_usd
    FROM llm_usage WHERE organization_id = ?
      AND created_at >= ?
  `).get(
    req.auth.organization_id,
    new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
  );
  const pending = db.prepare(`
    SELECT COUNT(*) AS count FROM billing_outbox o
    JOIN usage_events u ON u.id = o.usage_event_id
    WHERE u.organization_id = ? AND o.status = 'pending'
  `).get(req.auth.organization_id);
  res.json({
    subscription,
    billing: {
      mode: account.mode,
      balance_micro_usd: account.balance_micro_usd,
      reserved_micro_usd: account.reserved_micro_usd
    },
    usage: totals,
    token_usage: tokenUsage,
    pending_meter_events: pending.count
  });
});

app.get('/api/admin/llm-usage', requireAuthentication, (req, res) => {
  if (!['company_admin', 'head_of_product'].includes(req.auth.organization_role)) {
    return res.status(403).json({ error: 'Only Company Admins and Heads of Product can view LLM usage.' });
  }
  const limit = Number.parseInt(req.query.limit || '100', 10);
  res.json({
    usage: getLlmUsage(req.auth.organization_id, Number.isFinite(limit) ? limit : 100)
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/generate', requireAuthentication, requireCsrf, generationRateLimit, enforceUsage, async (req, res) => {
  try {
    const { text = '', project_id: projectId } = req.body || {};
    let generationContext = typeof text === 'string' ? text.trim() : '';
    if (projectId) {
      const contextResult = projectService.assembleProjectContext(
        req.auth.organization_id,
        projectId,
        generationContext
      );
      if (!contextResult) {
        return res.status(404).json({ error: 'Project not found in this workspace.' });
      }
      generationContext = contextResult.context;
    }
    if (!generationContext) {
      return res.status(400).json({ error: 'Text is required.' });
    }

    const result = await orchestrateArtifacts(
      generationContext,
      createTrackedAgentClient(req)
    );
    if (projectId) {
      projectService.saveProjectArtifact(req.auth.organization_id, projectId, req.auth.user_id, result);
    }
    recordRequestUsage(req, res, 'project_pack', 4, false);
    res.json(result);
  } catch (error) {
    logError('project_pack_generation_failed', error, {
      request_id: req.requestId,
      user_id: req.auth.user_id,
      organization_id: req.auth.organization_id
    });
    res.status(500).json({ error: error.message || 'Failed to generate project pack.' });
  }
});

app.post('/api/ask', requireAuthentication, requireCsrf, generationRateLimit, enforceUsage, async (req, res) => {
  try {
    const { context, question } = req.body || {};
    if (typeof context !== 'string' || !context.trim()) {
      return res.status(400).json({ error: 'Project context is required.' });
    }
    if (typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'A question is required.' });
    }

    const answer = await answerProductQuestion(
      context,
      question,
      createTrackedAgentClient(req)
    );
    recordRequestUsage(req, res, 'product_question', 1, false);
    res.json(answer);
  } catch (error) {
    logError('product_question_failed', error, {
      request_id: req.requestId,
      user_id: req.auth.user_id,
      organization_id: req.auth.organization_id
    });
    res.status(500).json({ error: error.message || 'Failed to answer project question.' });
  }
});

app.post('/api/meeting-agenda', requireAuthentication, requireCsrf, generationRateLimit, enforceUsage, async (req, res) => {
  try {
    const { context, trigger } = req.body || {};
    const agenda = await generateMeetingAgenda(
      context,
      trigger,
      createTrackedAgentClient(req)
    );
    recordRequestUsage(req, res, 'meeting_agenda', 1, false);
    res.json(agenda);
  } catch (error) {
    logError('meeting_agenda_generation_failed', error, {
      request_id: req.requestId,
      user_id: req.auth.user_id,
      organization_id: req.auth.organization_id
    });
    res.status(400).json({ error: error.message || 'Failed to prepare meeting agenda.' });
  }
});

app.post('/api/standup-draft', requireAuthentication, requireCsrf, (req, res) => {
  try {
    const { updates } = req.body || {};
    res.json(buildStandupDraft(updates));
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to prepare stand-up update.' });
  }
});

app.get('/api/integrations/slack/members', requireAuthentication, async (req, res) => {
  try {
    res.json({ members: await standupService.listSlackMembers(req.auth.organization_id) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/standup/schedules', requireAuthentication, (req, res) => {
  const schedules = db.prepare(`
    SELECT id, send_time, timezone, slack_user_ids, jira_site_id, jira_issue_key, enabled
    FROM standup_schedules WHERE organization_id = ? ORDER BY created_at DESC
  `).all(req.auth.organization_id).map((schedule) => ({
    ...schedule,
    slack_user_ids: JSON.parse(schedule.slack_user_ids)
  }));
  res.json({ schedules });
});

app.post('/api/standup/schedules', requireAuthentication, requireCsrf, async (req, res) => {
  try {
    const members = await standupService.listSlackMembers(req.auth.organization_id);
    const schedule = standupService.createSchedule(
      req.auth.organization_id,
      req.auth.user_id,
      req.auth.organization_role,
      req.body,
      members
    );
    res.status(201).json({ schedule });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/standup/schedules/:scheduleId', requireAuthentication, requireCsrf, (req, res) => {
  try {
    const removed = standupService.disableSchedule(
      req.auth.organization_id,
      req.auth.organization_role,
      req.params.scheduleId
    );
    if (!removed) return res.status(404).json({ error: 'Stand-up schedule not found.' });
    res.status(204).end();
  } catch (error) {
    res.status(403).json({ error: error.message });
  }
});

app.post('/api/export-excel', requireAuthentication, requireCsrf, async (req, res) => {
  try {
    const { stories = [] } = req.body || {};
    if (!Array.isArray(stories) || stories.length > 500) {
      return res.status(400).json({ error: 'Provide up to 500 stories to export.' });
    }

    const safeCell = (value) => {
      const text = String(value || '');
      return /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
    };
    const rows = stories.map((story, index) => ({
      ID: index + 1,
      Title: safeCell(story.title || `Story ${index + 1}`),
      'As a': safeCell(story.as_a),
      'I want': safeCell(story.i_want),
      'So that': safeCell(story.so_that),
      Priority: safeCell(story.priority || 'Medium'),
      Labels: safeCell(Array.isArray(story.labels) ? story.labels.join(', ') : ''),
      'Acceptance criteria': safeCell(Array.isArray(story.acceptance_criteria)
        ? story.acceptance_criteria.join(' | ')
        : '')
    }));

    const headers = Object.keys(rows[0] || {
      ID: 0,
      Title: '',
      'As a': '',
      'I want': '',
      'So that': '',
      Priority: '',
      Labels: '',
      'Acceptance criteria': ''
    });
    const worksheet = XLSX.utils.aoa_to_sheet([
      headers,
      ...rows.map((row) => headers.map((header) => row[header]))
    ]);
    worksheet['!cols'] = headers.map((header) => ({ wch: Math.min(60, Math.max(14, header.length + 4)) }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'User Stories');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename=product-owner-ai-backlog.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buffer));
  } catch (error) {
    logError('excel_export_failed', error, { request_id: req.requestId, user_id: req.auth.user_id });
    res.status(500).json({ error: 'Could not generate Excel export.' });
  }
});

app.post('/api/jira-payload', requireAuthentication, requireCsrf, (req, res) => {
  try {
    const { stories = [] } = req.body || {};

    const issues = stories.map((story, index) => ({
      index: index + 1,
      summary: story.title || `Story ${index + 1}`,
      description: `As a ${story.as_a || 'user'}\nI want ${story.i_want || 'this capability'}\nSo that ${story.so_that || 'the outcome is improved'}`,
      labels: story.labels || [],
      priority: story.priority || 'Medium'
    }));

    res.json({ issues });
  } catch (error) {
    logError('jira_payload_generation_failed', error, {
      request_id: req.requestId,
      user_id: req.auth.user_id
    });
    res.status(500).json({ error: 'Could not build Jira payload.' });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500
    ? error.status
    : 500;
  logError('unhandled_http_error', error, {
    request_id: req.requestId,
    method: req.method,
    path: req.path,
    status
  });
  return res.status(status).json({
    error: status === 500 ? 'An unexpected server error occurred.' : 'The request could not be processed.',
    request_id: req.requestId
  });
});

if (require.main === module) {
  app.listen(port, () => {
    log('info', 'server_started', { port, public_base_url: publicBaseUrl() });
  });
  const reservationCleanup = setInterval(() => {
    try {
      cleanupExpiredReservations();
    } catch (error) {
      logError('managed_reservation_cleanup_failed', error);
    }
  }, 60 * 60 * 1000);
  reservationCleanup.unref();
  try {
    cleanupExpiredReservations();
  } catch (error) {
    logError('managed_reservation_startup_cleanup_failed', error);
  }
const billingWorker = setInterval(() => {
  drainBillingOutbox().catch((error) => logError('billing_outbox_processing_failed', error));
}, 30000);
billingWorker.unref();
drainBillingOutbox().catch((error) => logError('billing_outbox_startup_processing_failed', error));
const standupWorker = setInterval(() => {
  standupService.sendDueStandups().catch((error) => logError('standup_schedule_worker_failed', error));
}, 60000);
standupWorker.unref();
standupService.sendDueStandups().catch((error) => logError('standup_scheduler_startup_failed', error));
}

module.exports = app;
