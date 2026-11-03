const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const XLSX = require('@e965/xlsx');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'product-owner-ai-auth-'));
process.env.DATA_DIRECTORY = testDirectory;
process.env.DATABASE_PATH = path.join(testDirectory, 'test.sqlite');
process.env.APP_SECRET = 'auth-test-secret-with-more-than-thirty-two-characters';
process.env.PUBLIC_BASE_URL = 'https://test.example';
process.env.GOOGLE_CLIENT_ID = 'google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
process.env.ATLASSIAN_CLIENT_ID = 'atlassian-client-id';
process.env.ATLASSIAN_CLIENT_SECRET = 'atlassian-client-secret';
process.env.SLACK_CLIENT_ID = 'slack-client-id';
process.env.SLACK_CLIENT_SECRET = 'slack-client-secret';
process.env.LLM_INPUT_COST_MICRO_USD_PER_MILLION = '150000';
process.env.LLM_OUTPUT_COST_MICRO_USD_PER_MILLION = '600000';
process.env.MANAGED_LLM_MARKUP_BPS = '3000';
process.env.STRIPE_SECRET_KEY = 'sk_test_product-owner-ai';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_product-owner-ai-test';

const auth = require('../backend/services/authService');
const projects = require('../backend/services/projectService');
const { db } = require('../backend/services/database');
const { createRateLimiter } = require('../backend/services/rateLimitService');
const {
  processStripeEvent,
  recordUsage,
  getBillingAccount,
  reserveManagedCredits,
  recordLlmUsage,
  releaseManagedReservation,
  getLlmUsage,
  getStripe,
  setBillingMode
} = require('../backend/services/billingService');
const standups = require('../backend/services/standupService');
const documents = require('../backend/services/documentService');
const app = require('../backend/server');
let server;

function extractCookie(value, name) {
  const match = value.find((item) => item.startsWith(`${name}=`));
  return match.split(';')[0];
}

function getAuthenticatedSession() {
  const account = auth.findOrCreateAccount({
    subject: 'google-subject-1',
    name: 'Consultant',
    email: 'consultant@example.test'
  }, 'google');
  const cookies = [];
  const response = { append: (_header, value) => cookies.push(value) };
  const csrf = auth.createSession(account.user.id, account.organizationId, response);
  const sessionCookie = extractCookie(cookies, auth.sessionCookieName);
  const token = decodeURIComponent(sessionCookie.slice(sessionCookie.indexOf('=') + 1));
  const request = {
    headers: { cookie: sessionCookie },
    get(name) {
      return name === 'X-CSRF-Token' ? csrf : undefined;
    }
  };
  auth.authenticate(request, {}, () => {});
  return { ...account, request, csrf, cookies, token };
}

test('OAuth start creates a PKCE-bound authorization URL and one-time browser state', () => {
  const authorization = auth.createAuthorization('google', 'login', null, '/');
  const url = new URL(authorization.url);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://test.example/auth/google/callback');
  assert.ok(url.searchParams.get('nonce'));
  const stateCookie = authorization.stateCookie.match(/poai_oauth=([^;]+)/)[1];
  const request = { headers: { cookie: `poai_oauth=${stateCookie}` } };
  const transaction = auth.consumeOAuthState('google', authorization.state, request);
  assert.equal(transaction.flow, 'login');
  assert.throws(() => auth.consumeOAuthState('google', authorization.state, request), /state validation failed/);
});

test('OAuth state cannot be replayed from another browser', () => {
  const authorization = auth.createAuthorization('atlassian', 'login', null);
  assert.throws(
    () => auth.consumeOAuthState('atlassian', authorization.state, { headers: { cookie: 'poai_oauth=wrong' } }),
    /state validation failed/
  );
});

test('OAuth provider endpoints use the expected authorization-code token exchange', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), ...options };
    return { ok: true, status: 200, json: async () => ({ access_token: 'access', id_token: 'identity' }) };
  };
  try {
    await auth.exchangeCode('google', 'oauth-code', 'pkce-verifier');
    assert.equal(request.url, 'https://oauth2.googleapis.com/token');
    assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(new URLSearchParams(request.body).get('code_verifier'), 'pkce-verifier');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Slack connection requests minimum bot scopes without unsupported PKCE parameters', () => {
  const owner = getAuthenticatedSession();
  const authorization = auth.createAuthorization('slack', 'connect', {
    id: owner.user.id,
    user_id: owner.user.id,
    organization_id: owner.organizationId
  });
  const url = new URL(authorization.url);
  assert.equal(url.origin, 'https://slack.com');
  assert.equal(url.searchParams.has('code_challenge'), false);
  assert.match(url.searchParams.get('scope'), /im:history/);
  assert.match(url.searchParams.get('scope'), /users:read/);
});

test('local email/password registration and login create a session and preserve encrypted profile credentials', () => {
  const cookies = [];
  const response = { append: (_header, value) => cookies.push(value) };
  const result = auth.registerLocalUser('Local User', 'local@example.test', 'secure-password', response);
  assert.equal(result.user.email, 'local@example.test');
  const login = auth.loginLocalUser('local@example.test', 'secure-password', response);
  assert.equal(login.user.id, result.user.id);

  const saved = auth.writeUserCredentials(login.user.id, 'jira', {
    site_url: 'https://jira.example.com',
    email: 'developer@example.test',
    api_token: 'secret-token'
  });
  assert.equal(saved.provider, 'jira');

  const credentials = auth.readUserCredentials(login.user.id);
  assert.deepEqual(credentials[0].values.site_url, 'https://jira.example.com');
  assert.deepEqual(credentials[0].values.api_token, 'secret-token');

  const deleted = auth.deleteUserCredentials(login.user.id, 'jira');
  assert.equal(deleted.deleted, true);
  assert.equal(auth.readUserCredentials(login.user.id).length, 0);
});

test('local signup cannot take over an existing OAuth identity by matching email', () => {
  auth.findOrCreateAccount({
    subject: 'google-subject-existing-email',
    name: 'OAuth User',
    email: 'same-email@example.test'
  }, 'google');
  assert.throws(
    () => auth.registerLocalUser('Attacker', 'same-email@example.test', 'password123', { append() {} }),
    /already associated with an account/
  );
});

test('rate limiter returns 429 after the configured fixed-window limit', () => {
  const limit = createRateLimiter({ name: 'test-auth', windowMs: 60_000, maxRequests: 1 });
  const request = { ip: '192.0.2.40' };
  let nextCalls = 0;
  let statusCode = 200;
  const headers = {};
  const response = {
    setHeader(name, value) { headers[name] = value; },
    status(code) { statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };

  limit(request, response, () => { nextCalls += 1; });
  limit(request, response, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.equal(statusCode, 429);
  assert.ok(headers['Retry-After']);
});

test('document ingestion validates supported formats and rejects malformed office archives', async () => {
  assert.equal(await documents.extractText('notes.txt', Buffer.from('Team delivery notes')), 'Team delivery notes');
  await assert.rejects(documents.extractText('notes.exe', Buffer.from('content')), /Supported documents/);
  await assert.rejects(documents.extractText('requirements.docx', Buffer.from('not a zip')), /ZIP directory is invalid/);
});

test('document ingestion extracts supported PDF, DOCX, and XLSX content', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Story', 'As a user I can sign in']
  ]), 'Stories');
  const xlsx = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  assert.match(await documents.extractText('stories.xlsx', xlsx), /As a user I can sign in/);

  const docx = Buffer.from(
    'UEsDBAoAAAAIAHulRF3GEnoHrAAAAPEAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbF2Puw7CMAxFf6XKihoXBgaUlIEdGPgBK3HbiOahJBT4exKQOjBax/dcWxxfdm4Wisl4J9mWd+zYi9s7UGoKcUmyKedwAEhqIouJ+0CukMFHi7mMcYSA6o4jwa7r9qC8y+Rym6uD9eJS5NFoaq4Y8xktSQZPHzVorx62bPJiY83pF6vNkmEIs1GYy02wOP3X2fphMIrWfLWF6BWlZNxoZ74Si8Ztqh56Ad+n+g9QSwMECgAAAAAAe6VEXQAAAAAAAAAAAAAAAAUAAAB3b3JkL1BLAwQKAAAACAB7pURdCYbjIJAAAADEAAAAEQAAAHdvcmQvZG9jdW1lbnQueG1sRY5LDsIwDESvEuUAuLBgUfUjTsE6pG4bqbEjx1C4PUlZsHkja0ZP7sZ33MwLJQem3p5PjR2Hbm8n9s+IpKbUlNu9t6tqagGyXzG6fOKEVLqZJTotpyyws0xJ2GPOgZa4waVprhBdIFuVD54+NVOFVOhw8x6TOvJovARFCc7MwtHci6uDOqmUg+ngTwP/F4cvUEsBAhQACgAAAAgAe6VEXcYSegesAAAA8QAAABMAAAAAAAAAAAAAAAAAAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAAKAAAAAAB7pURdAAAAAAAAAAAAAAAABQAAAAAAAAAAABAAAADdAAAAd29yZC9QSwECFAAKAAAACAB7pURdCYbjIJAAAADEAAAAEQAAAAAAAAAAAAAAAAAAAQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwCzAAAAvwEAAAAA',
    'base64'
  );
  assert.match(await documents.extractText('requirements.docx', docx), /Acceptance criteria from Word/);

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '5 0 obj\n<< /Length 49 >>\nstream\nBT /F1 12 Tf 72 720 Td (Project risk review) Tj ET\nendstream\nendobj\n'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  assert.match(await documents.extractText('risks.pdf', Buffer.from(pdf)), /Project risk review/);
});

test('session cookies use hashed persistent sessions and a validated CSRF token', () => {
  const account = getAuthenticatedSession();
  assert.equal(account.request.auth.user_id, account.user.id);
  assert.equal(account.request.auth.organization_id, account.organizationId);
  assert.equal(account.cookies[0].includes('HttpOnly'), true);
  assert.equal(account.request.auth.tokenHash, auth.sha256(account.token));

  let nextCalled = false;
  let statusCode = 200;
  const response = { status(code) { statusCode = code; return this; }, json(value) { this.body = value; } };
  auth.requireCsrf(account.request, response, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  account.request.get = () => 'invalid';
  auth.requireCsrf(account.request, response, () => { nextCalled = true; });
  assert.equal(statusCode, 403);
});

test('projects and documents are encrypted and scoped to their workspace', () => {
  const account = getAuthenticatedSession();
  const project = projects.createProject(account.organizationId, account.user.id, 'Client migration', 'Confidential project notes');
  projects.addDocument(account.organizationId, project.id, account.user.id, 'requirements.md', 'Private requirements text');
  const raw = db.prepare('SELECT context FROM projects WHERE id = ?').get(project.id).context;
  assert.equal(raw.includes('Confidential project notes'), false);
  const result = projects.assembleProjectContext(account.organizationId, project.id);
  assert.match(result.context, /Private requirements text/);
  projects.saveProjectArtifact(account.organizationId, project.id, account.user.id, { user_stories: [{ title: 'Example' }] });
  assert.match(projects.assembleProjectContext(account.organizationId, project.id).context, /Latest generated project pack/);
  assert.equal(projects.getProject('another-workspace', project.id), null);
  assert.equal(projects.assembleProjectContext('another-workspace', project.id), null);
});

test('workspace invites require admin membership and can be accepted once', () => {
  const owner = getAuthenticatedSession();
  const invite = auth.issueInvitation(owner.organizationId, owner.user.id, 'member@example.test', 'member');
  const member = auth.findOrCreateAccount({
    subject: 'google-subject-2',
    name: 'Team Member',
    email: 'member@example.test'
  }, 'google');
  const joinedWorkspace = auth.acceptInvitation(invite.token, member.user);
  assert.equal(joinedWorkspace.id, owner.organizationId);
  assert.throws(() => auth.acceptInvitation(invite.token, member.user), /invalid or expired/);
  assert.equal(
    db.prepare('SELECT role FROM memberships WHERE organization_id = ? AND user_id = ?')
      .get(owner.organizationId, member.user.id).role,
    'member'
  );
});

test('organization role management supports all requested roles and retains a Company Admin', () => {
  const owner = getAuthenticatedSession();
  const member = auth.findOrCreateAccount({
    subject: 'google-subject-role-member',
    name: 'Role Member',
    email: 'role-member@example.test'
  }, 'google');
  db.prepare(`
    INSERT INTO memberships (organization_id, user_id, role, organization_role, created_at)
    VALUES (?, ?, 'member', 'product_owner', ?)
  `).run(owner.organizationId, member.user.id, new Date().toISOString());

  for (const role of ['product_owner', 'scrum_master', 'head_of_product', 'company_admin']) {
    assert.deepEqual(
      auth.updateOrganizationMemberRole(owner.organizationId, member.user.id, role),
      { user_id: member.user.id, role }
    );
  }
  auth.updateOrganizationMemberRole(owner.organizationId, member.user.id, 'product_owner');
  assert.throws(
    () => auth.updateOrganizationMemberRole(owner.organizationId, owner.user.id, 'head_of_product'),
    /retain at least one Company Admin/
  );
  assert.deepEqual(
    auth.listOrganizationMembers(owner.organizationId)
      .filter((item) => [owner.user.id, member.user.id].includes(item.id))
      .map((item) => item.role)
      .sort(),
    ['company_admin', 'product_owner']
  );
});

test('stand-up schedules are workspace scoped and validate Slack recipients and timezone', () => {
  const owner = getAuthenticatedSession();
  const schedule = standups.createSchedule(owner.organizationId, owner.user.id, 'owner', {
    send_time: '09:15',
    timezone: 'Europe/London',
    slack_user_ids: ['U12345678']
  }, [{ id: 'U12345678', name: 'Member' }]);
  assert.equal(schedule.member_count, 1);
  assert.throws(() => standups.createSchedule(owner.organizationId, owner.user.id, 'product_owner', {
    send_time: '09:15',
    timezone: 'Europe/London',
    slack_user_ids: ['U12345678']
  }, [{ id: 'U12345678' }]), /Only Company Admins and Scrum Masters/);
  assert.throws(() => standups.createSchedule(owner.organizationId, owner.user.id, 'owner', {
    send_time: '99:99',
    timezone: 'Europe/London',
    slack_user_ids: ['U12345678']
  }, [{ id: 'U12345678' }]), /valid daily send time/);
});

test('Slack webhook requests require a recent HMAC signature', () => {
  process.env.SLACK_SIGNING_SECRET = 'slack-signature-test-secret';
  const rawBody = Buffer.from('{"type":"url_verification","challenge":"challenge"}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody.toString('utf8')}`).digest('hex');
  const headers = {
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': `v0=${digest}`
  };
  const request = {
    rawBody,
    get(name) { return headers[name.toLowerCase()]; }
  };
  assert.equal(standups.verifySlackSignature(request), true);
  headers['x-slack-signature'] = 'v0=bad';
  assert.equal(standups.verifySlackSignature(request), false);
});

test('Stripe subscriptions are workspace scoped and webhook event processing is idempotent', () => {
  process.env.STRIPE_PRICE_TEAM = 'price_team_test';
  const account = getAuthenticatedSession();
  const event = {
    id: 'evt_test_subscription',
    type: 'customer.subscription.created',
    data: {
      object: {
        id: 'sub_test',
        customer: 'cus_test',
        status: 'active',
        metadata: { organization_id: account.organizationId, plan: 'team' },
        items: { data: [{ price: { id: 'price_team_test' } }] }
      }
    }
  };
  assert.equal(processStripeEvent(event), true);
  assert.equal(processStripeEvent(event), false);
  assert.equal(db.prepare('SELECT plan FROM subscriptions WHERE organization_id = ?')
    .get(account.organizationId).plan, 'team');
  const id = recordUsage(account.organizationId, account.user.id, 'project_pack', 4, true, 'platform');
  assert.equal(db.prepare('SELECT units FROM usage_events WHERE id = ?').get(id).units, 4);
});

test('managed API credit ledger enforces reservations and records exact token telemetry', () => {
  const account = getAuthenticatedSession();
  process.env.STRIPE_PRICE_BYOK = 'price_byok_test';
  const byokSubscription = {
    id: 'evt_test_byok_subscription',
    type: 'customer.subscription.created',
    data: {
      object: {
        id: 'sub_test_byok',
        customer: 'cus_test_byok',
        status: 'active',
        metadata: { organization_id: account.organizationId, plan: 'byok' },
        items: { data: [{ price: { id: 'price_byok_test' } }] }
      }
    }
  };
  assert.equal(processStripeEvent(byokSubscription), true);
  assert.equal(getBillingAccount(account.organizationId).mode, 'byok');
  assert.equal(setBillingMode(account.organizationId, 'byok').mode, 'byok');

  const event = {
    id: 'evt_test_managed_credit_pack',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_managed_credit_pack',
        mode: 'payment',
        payment_status: 'paid',
        metadata: {
          purpose: 'managed_api_credits',
          organization_id: account.organizationId,
          credits_micro_usd: '5000000'
        }
      }
    }
  };
  assert.equal(processStripeEvent(event), true);
  assert.equal(processStripeEvent(event), false);
  assert.equal(processStripeEvent({
    ...event,
    id: 'evt_test_managed_credit_async',
    type: 'checkout.session.async_payment_succeeded'
  }), true);
  assert.equal(getBillingAccount(account.organizationId).balance_micro_usd, 5_000_000);
  assert.equal(setBillingMode(account.organizationId, 'managed').mode, 'managed');

  const requestId = 'request-managed-usage';
  reserveManagedCredits(account.organizationId, account.user.id, requestId, 1_000_000);
  const recorded = recordLlmUsage(account.organizationId, account.user.id, requestId, 'managed', {
    provider: 'openai',
    model: 'gpt-4o-mini',
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500
  });
  releaseManagedReservation(requestId, account.organizationId);

  const usage = getLlmUsage(account.organizationId, 1)[0];
  assert.equal(usage.user_id, account.user.id);
  assert.equal(usage.model, 'gpt-4o-mini');
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.output_tokens, 500);
  assert.equal(usage.total_tokens, 1500);
  assert.equal(usage.cost_micro_usd, 450);
  assert.equal(usage.charged_micro_usd, 585);
  assert.equal(getBillingAccount(account.organizationId).balance_micro_usd, 5_000_000 - recorded.charged_micro_usd);
  assert.equal(getBillingAccount(account.organizationId).reserved_micro_usd, 0);
  assert.throws(
    () => reserveManagedCredits(account.organizationId, account.user.id, 'request-too-large', 5_000_000),
    /credit balance is too low/
  );

  setBillingMode(account.organizationId, 'byok');
  const byokUsage = recordLlmUsage(account.organizationId, account.user.id, 'request-byok', 'byok', {
    provider: 'openai',
    model: 'gpt-4o-mini',
    inputTokens: 50,
    outputTokens: 25,
    totalTokens: 75
  });
  assert.equal(byokUsage.charged_micro_usd, 0);
});

test('HTTP API requires accounts, returns sign-in providers, and isolates projects by workspace', async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const providersResponse = await fetch(`${baseUrl}/api/auth/providers`);
  assert.equal(providersResponse.status, 200);
  const configured = await providersResponse.json();
  assert.equal(configured.google, true);
  assert.equal(configured.atlassian, true);

  const unauthenticated = await fetch(`${baseUrl}/api/projects`);
  assert.equal(unauthenticated.status, 401);

  const owner = getAuthenticatedSession();
  const credentialSaveResponse = await fetch(`${baseUrl}/api/profile/credentials`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${owner.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      provider: 'openai',
      values: { api_key: 'do-not-return-this-secret', default_model: 'gpt-4o-mini' }
    })
  });
  assert.equal(credentialSaveResponse.status, 201);
  assert.doesNotMatch(await credentialSaveResponse.text(), /do-not-return-this-secret/);
  const profileCredentialsResponse = await fetch(`${baseUrl}/api/profile/credentials`, {
    headers: { Authorization: `Bearer ${owner.token}` }
  });
  const profileCredentials = await profileCredentialsResponse.json();
  assert.deepEqual(profileCredentials.credentials.find((item) => item.provider === 'openai')
    .configured_secret_fields, ['api_key']);
  assert.doesNotMatch(JSON.stringify(profileCredentials), /do-not-return-this-secret/);

  const roleResponse = await fetch(`${baseUrl}/api/workspaces/members`, {
    headers: { Authorization: `Bearer ${owner.token}` }
  });
  assert.equal(roleResponse.status, 200);
  assert.equal((await roleResponse.json()).members[0].role, 'company_admin');

  const protectedRoleChange = await fetch(
    `${baseUrl}/api/workspaces/members/${owner.user.id}/role`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ role: 'head_of_product' })
    }
  );
  assert.equal(protectedRoleChange.status, 400);

  const signedEventBody = JSON.stringify({
    id: 'evt_http_signed_test',
    object: 'event',
    api_version: '2025-03-31.basil',
    created: Math.floor(Date.now() / 1000),
    data: { object: {} },
    livemode: false,
    pending_webhooks: 1,
    type: 'test.event'
  });
  const signature = getStripe().webhooks.generateTestHeaderString({
    payload: signedEventBody,
    secret: process.env.STRIPE_WEBHOOK_SECRET
  });
  const rejectedWebhook = await fetch(`${baseUrl}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'invalid' },
    body: signedEventBody
  });
  assert.equal(rejectedWebhook.status, 400);
  const acceptedWebhook = await fetch(`${baseUrl}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: signedEventBody
  });
  assert.equal(acceptedWebhook.status, 200);
  const duplicateWebhook = await fetch(`${baseUrl}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: signedEventBody
  });
  assert.equal(duplicateWebhook.status, 200);

  const createResponse = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${owner.token}`,
      'X-CSRF-Token': owner.csrf,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: 'Workspace project', context: 'Private customer context' })
  });
  assert.equal(createResponse.status, 201);
  const { project } = await createResponse.json();
  const uploadResponse = await fetch(`${baseUrl}/api/projects/${project.id}/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${owner.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'meeting.txt',
      content_base64: Buffer.from('The team agreed to review open risks.').toString('base64')
    })
  });
  assert.equal(uploadResponse.status, 201);
  assert.equal((await uploadResponse.json()).document.name, 'meeting.txt');

  const member = auth.findOrCreateAccount({
    subject: 'google-subject-isolated',
    name: 'Other User',
    email: 'other@example.test'
  }, 'google');
  const memberCookies = [];
  auth.createSession(member.user.id, member.organizationId, {
    append: (_header, value) => memberCookies.push(value)
  });
  const memberSession = decodeURIComponent(extractCookie(memberCookies, auth.sessionCookieName)
    .slice(auth.sessionCookieName.length + 1));
  const hiddenProject = await fetch(`${baseUrl}/api/projects/${project.id}/context`, {
    headers: { Authorization: `Bearer ${memberSession}` }
  });
  assert.equal(hiddenProject.status, 404);

  const loginPage = await fetch(baseUrl);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Sign in with Google/);
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
});
