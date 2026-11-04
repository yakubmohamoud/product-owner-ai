const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const { db, encrypt, decrypt, sha256, createId } = require('./database');

const sessionCookieName = 'poai_session';
const oauthCookieName = 'poai_oauth';
const sessionLifetimeMs = 1000 * 60 * 60 * 24 * 14;
const oauthStateLifetimeMs = 1000 * 60 * 10;

const providers = {
  google: {
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'profile'],
    driveScopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/calendar.events'
    ]
  },
  atlassian: {
    clientId: () => process.env.ATLASSIAN_CLIENT_ID || process.env.JIRA_CLIENT_ID,
    clientSecret: () => process.env.ATLASSIAN_CLIENT_SECRET || process.env.JIRA_CLIENT_SECRET,
    authorizationUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    scopes: ['read:me'],
    integrationScopes: [
      'read:me',
      'read:jira-user',
      'read:jira-work',
      'write:jira-work',
      'read:confluence-content.all',
      'write:confluence-content',
      'offline_access'
    ]
  },
  slack: {
    clientId: () => process.env.SLACK_CLIENT_ID,
    clientSecret: () => process.env.SLACK_CLIENT_SECRET,
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['chat:write', 'im:write', 'im:read', 'im:history', 'users:read'],
    loginEnabled: false
  },
  zoom: {
    clientId: () => process.env.ZOOM_CLIENT_ID,
    clientSecret: () => process.env.ZOOM_CLIENT_SECRET,
    authorizationUrl: 'https://zoom.us/oauth/authorize',
    tokenUrl: 'https://zoom.us/oauth/token',
    scopes: ['user:read:user', 'recording:read:list_user_recordings', 'recording:read:recording_transcript'],
    loginEnabled: false
  },
  microsoft: {
    clientId: () => process.env.MICROSOFT_CLIENT_ID,
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET,
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Calendars.ReadWrite', 'OnlineMeetings.Read', 'OnlineMeetingTranscript.Read.All'],
    loginEnabled: false
  }
};

const localIdentityProvider = 'local_password';

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid email address is required.');
  }
  return email;
}

function hashPassword(password) {
  const normalized = typeof password === 'string' ? password : '';
  if (normalized.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.pbkdf2Sync(normalized, salt, 200000, 32, 'sha256');
  return `pbkdf2_sha256$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string' || !storedHash.startsWith('pbkdf2_sha256$')) {
    return false;
  }
  const [, saltBase64, hashBase64] = storedHash.split('$');
  if (!saltBase64 || !hashBase64) return false;
  const salt = Buffer.from(saltBase64, 'base64url');
  const expected = Buffer.from(hashBase64, 'base64url');
  const actual = crypto.pbkdf2Sync(String(password || ''), salt, 200000, expected.length, 'sha256');
  return crypto.timingSafeEqual(actual, expected);
}

function safeDisplayName(name, fallback = 'User') {
  const value = typeof name === 'string' ? name.trim() : '';
  return value || fallback;
}

const organizationRoles = ['company_admin', 'product_owner', 'scrum_master', 'head_of_product'];

function normalizeProviderKey(value) {
  const provider = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  switch (provider) {
    case 'google_drive':
    case 'google-drive':
    case 'googledrive':
      return 'google_drive';
    default:
      return provider;
  }
}

function publicBaseUrl() {
  const value = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
  const url = new URL(value);
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_BASE_URL must use HTTPS in production.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || (!isLocal && url.protocol !== 'https:')) {
    throw new Error('PUBLIC_BASE_URL must use HTTPS except for localhost development.');
  }
  return url.origin;
}

function callbackUrl(provider) {
  return `${publicBaseUrl()}/auth/${provider}/callback`;
}

function isSecureCookie() {
  return new URL(publicBaseUrl()).protocol === 'https:';
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function csrfTokenForSession(token) {
  return crypto.createHmac('sha256', Buffer.from(token)).update('poai-csrf-v1').digest('base64url');
}

function cookieHeader(name, value, options = {}) {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${options.sameSite || 'Lax'}`,
    `Max-Age=${options.maxAge ?? 600}`
  ];
  if (options.secure ?? isSecureCookie()) attributes.push('Secure');
  return attributes.join('; ');
}

function clearCookieHeader(name, sameSite = 'Lax') {
  return cookieHeader(name, '', { maxAge: 0, sameSite });
}

function readCookies(req) {
  const result = {};
  for (const item of (req.headers.cookie || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    try {
      result[key] = decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      continue;
    }
  }
  return result;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function providerConfig(provider) {
  const config = providers[provider];
  if (!config) throw new Error('Unsupported sign-in provider.');
  const clientId = config.clientId();
  const clientSecret = config.clientSecret();
  if (!clientId || !clientSecret) {
    throw new Error(`${provider} sign-in is not configured. Set its OAuth client ID and secret.`);
  }
  return { ...config, clientId, clientSecret };
}

function createAuthorization(provider, flow, user, returnTo = '/') {
  if (!['login', 'connect'].includes(flow)) {
    throw new Error('OAuth flow must be login or connect.');
  }
  if (flow === 'connect' && !user) {
    throw new Error('Sign in before connecting an integration.');
  }
  if (flow === 'login' && providers[provider]?.loginEnabled === false) {
    throw new Error('This provider is available as a workspace integration, not as a sign-in provider.');
  }
  const config = providerConfig(provider);
  const state = randomToken();
  const cookie = randomToken();
  const verifier = randomToken();
  const nonce = ['google', 'microsoft'].includes(provider) ? randomToken() : null;
  const supportsPkce = !['slack', 'zoom'].includes(provider);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const safeReturnTo = typeof returnTo === 'string' && /^\/[a-zA-Z0-9/_-]*$/.test(returnTo)
    ? returnTo
    : '/';
  const now = new Date();
  db.prepare(`
    INSERT INTO oauth_states
      (state_hash, cookie_hash, provider, flow, verifier, nonce, user_id, organization_id, return_to, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sha256(state),
    sha256(cookie),
    provider,
    flow,
    verifier,
    nonce,
    user?.id || user?.user_id || null,
    user?.organization_id || null,
    safeReturnTo,
    new Date(now.getTime() + oauthStateLifetimeMs).toISOString(),
    now.toISOString()
  );

  const url = new URL(config.authorizationUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', callbackUrl(provider));
  url.searchParams.set('response_type', 'code');
  const requestedScopes = flow === 'connect'
    ? (provider === 'google' ? [...config.scopes, ...config.driveScopes] : config.integrationScopes || config.scopes)
    : config.scopes;
  url.searchParams.set('scope', requestedScopes.join(provider === 'slack' ? ',' : ' '));
  url.searchParams.set('state', state);
  if (supportsPkce) {
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (nonce) url.searchParams.set('nonce', nonce);
  if (provider === 'google' && flow === 'connect') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
  }
  if (provider === 'atlassian') {
    url.searchParams.set('audience', 'api.atlassian.com');
    url.searchParams.set('prompt', 'consent');
  }

  return {
    url: url.toString(),
    stateCookie: cookieHeader(oauthCookieName, cookie),
    state
  };
}

function consumeOAuthState(provider, state, req) {
  const cookie = readCookies(req)[oauthCookieName];
  if (!cookie || !state) {
    throw new Error('OAuth state validation failed. Restart sign-in from this application.');
  }
  const row = db.prepare(`
    SELECT * FROM oauth_states WHERE state_hash = ? AND provider = ?
  `).get(sha256(state), provider);
  db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(new Date().toISOString());
  if (!row || new Date(row.expires_at) <= new Date() || !constantTimeEqual(row.cookie_hash, sha256(cookie))) {
    throw new Error('OAuth state validation failed. Restart sign-in from this application.');
  }
  db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(row.state_hash);
  return row;
}

async function exchangeCode(provider, code, verifier) {
  const config = providerConfig(provider);
  const values = {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: callbackUrl(provider),
    ...(!['slack', 'zoom'].includes(provider) ? { code_verifier: verifier } : {}),
    ...(provider === 'atlassian' ? { audience: 'api.atlassian.com' } : {})
  };
  const formProvider = ['google', 'slack', 'zoom', 'microsoft'].includes(provider);
  const body = provider === 'zoom'
    ? new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(provider)
    })
    : formProvider
      ? new URLSearchParams(values)
      : JSON.stringify(values);
  const headers = {
    'Content-Type': formProvider ? 'application/x-www-form-urlencoded' : 'application/json',
    Accept: 'application/json'
  };
  if (provider === 'zoom') {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
  }
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15000)
  });
  const token = await response.json();
  if (!response.ok || !token.access_token) {
    throw new Error(`${provider} token exchange failed (${response.status}). Check the OAuth credentials and exact callback URL.`);
  }
  return token;
}

async function loadProfile(provider, token, nonce) {
  if (provider === 'google') {
    const config = providerConfig(provider);
    const client = new OAuth2Client(config.clientId);
    const ticket = await client.verifyIdToken({
      idToken: token.id_token,
      audience: config.clientId
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || payload.email_verified !== true || !constantTimeEqual(payload.nonce, nonce)) {
      throw new Error('Google sign-in returned an invalid or unverified identity.');
    }
    return {
      subject: payload.sub,
      email: payload.email?.toLowerCase() || null,
      name: payload.name || payload.email || 'Google user'
    };
  }

  if (provider === 'slack') {
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    const profile = await response.json();
    if (!response.ok || !profile.ok || !profile.team_id) {
      throw new Error('Slack could not verify the connected workspace.');
    }
    return {
      subject: profile.team_id,
      email: null,
      name: profile.team || profile.team_id,
      metadata: { team_id: profile.team_id, team_name: profile.team, bot_user_id: profile.user_id }
    };
  }

  if (provider === 'zoom') {
    const response = await fetch('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    const profile = await response.json();
    if (!response.ok || !profile.id) throw new Error('Zoom could not verify the connected account.');
    return {
      subject: profile.id,
      email: profile.email || null,
      name: profile.display_name || profile.first_name || profile.email || 'Zoom user'
    };
  }

  if (provider === 'microsoft') {
    if (!token.id_token) throw new Error('Microsoft sign-in did not return an ID token.');
    const { createRemoteJWKSet, decodeJwt, jwtVerify } = await import('jose');
    const unverified = decodeJwt(token.id_token);
    const tenantId = unverified.tid;
    if (typeof tenantId !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(tenantId)) {
      throw new Error('Microsoft identity token has an invalid tenant identifier.');
    }
    const discoveryResponse = await fetch('https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration', {
      signal: AbortSignal.timeout(15000)
    });
    if (!discoveryResponse.ok) throw new Error('Microsoft OpenID configuration could not be loaded.');
    const discovery = await discoveryResponse.json();
    const issuer = discovery.issuer.replace('{tenantid}', tenantId);
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const verified = await jwtVerify(token.id_token, jwks, {
      issuer,
      audience: providerConfig('microsoft').clientId,
      nonce
    });
    const response = await fetch('https://graph.microsoft.com/oidc/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    const profile = await response.json();
    if (!response.ok || !profile.sub || profile.sub !== verified.payload.sub) {
      throw new Error('Microsoft identity validation failed.');
    }
    return {
      subject: profile.sub,
      email: (profile.email || profile.preferred_username || '').toLowerCase() || null,
      name: profile.name || profile.email || 'Microsoft user'
    };
  }

  const response = await fetch('https://api.atlassian.com/me', {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  const profile = await response.json();
  if (!response.ok || !profile.account_id) {
    throw new Error(`Atlassian identity lookup failed (${response.status}). Ensure the app requests the read:me scope.`);
  }
  return {
    subject: profile.account_id,
    email: typeof profile.email === 'string' ? profile.email.toLowerCase() : null,
    name: profile.name || profile.nickname || profile.email || 'Atlassian user'
  };
}

function findOrCreateAccount(profile, provider) {
  const identity = db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').get(provider, profile.subject);
  if (identity) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(identity.user_id);
    const membership = db.prepare(`
      SELECT organization_id FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1
    `).get(user.id);
    if (!membership) throw new Error('Account has no workspace membership.');
    return { user, organizationId: membership.organization_id };
  }

  const now = new Date().toISOString();
  const userId = createId();
  const organizationId = createId();
  const workspaceName = `${profile.name}'s Workspace`.slice(0, 100);
  const create = db.transaction(() => {
    db.prepare('INSERT INTO users (id, name, email, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, profile.name.slice(0, 120), profile.email, now, now);
    db.prepare('INSERT INTO organizations (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(organizationId, workspaceName, userId, now);
    db.prepare(`
      INSERT INTO memberships (organization_id, user_id, role, organization_role, created_at)
      VALUES (?, ?, 'owner', 'company_admin', ?)
    `).run(organizationId, userId, now);
    db.prepare('INSERT INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(provider, profile.subject, userId, now);
    db.prepare('INSERT INTO subscriptions (organization_id, updated_at) VALUES (?, ?)')
      .run(organizationId, now);
  });
  create();
  return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(userId), organizationId };
}

function registerLocalUser(name, email, password, res) {
  const safeName = safeDisplayName(name, 'Product Owner');
  const normalizedEmail = normalizeEmail(email);
  const localIdentity = db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').get(localIdentityProvider, normalizedEmail);
  if (localIdentity) {
    throw new Error('A local account for that email already exists. Sign in instead.');
  }

  const existingUser = db.prepare('SELECT * FROM users WHERE email = ? ORDER BY created_at LIMIT 1').get(normalizedEmail);
  if (existingUser) {
    throw new Error('That email is already associated with an account. Sign in with its existing provider.');
  }
  const now = new Date().toISOString();
  const userId = createId();
  const organizationId = createId();

  const transaction = db.transaction(() => {
    db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, safeName.slice(0, 120), normalizedEmail, hashPassword(password), now);
    db.prepare('INSERT INTO organizations (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(organizationId, `${safeName}'s Workspace`, userId, now);
    db.prepare(`
      INSERT INTO memberships (organization_id, user_id, role, organization_role, created_at)
      VALUES (?, ?, 'owner', 'company_admin', ?)
    `).run(organizationId, userId, now);
    db.prepare('INSERT INTO subscriptions (organization_id, updated_at) VALUES (?, ?)')
      .run(organizationId, now);
    db.prepare('INSERT OR IGNORE INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(localIdentityProvider, normalizedEmail, userId, now);
  });

  transaction();

  return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(userId), organizationId };
}

async function sendEmailVerification(user, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(user.id);
  db.prepare(`INSERT INTO email_verification_tokens (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)`).run(tokenHash, user.id, expiresAt.toISOString(), now.toISOString());

  const baseUrl = process.env.PUBLIC_BASE_URL || publicBaseUrl;
  const verifyUrl = `${String(baseUrl).replace(/\/$/, '')}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'MY PO <onboarding@resend.dev>',
        to: [user.email],
        subject: 'Confirm your MY PO email address',
        html: `<p>Welcome to MY PO.</p><p><a href="${verifyUrl}">Confirm your email address</a></p><p>This link expires in 24 hours.</p>`
      })
    });
    if (!response.ok) throw new Error('We could not send the confirmation email. Please try again.');
  } else {
    console.log(JSON.stringify({ event: 'email_verification_link', email: user.email, verifyUrl }));
  }
  return verifyUrl;
}

function verifyEmailToken(token, res) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('The confirmation link is invalid or incomplete.');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const record = db.prepare('SELECT * FROM email_verification_tokens WHERE token_hash = ?').get(tokenHash);
  if (!record) throw new Error('This confirmation link is invalid or has already been used.');
  if (new Date(record.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM email_verification_tokens WHERE token_hash = ?').run(tokenHash);
    throw new Error('This confirmation link has expired. Sign in and request a new one.');
  }
  db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(new Date().toISOString(), record.user_id);
  db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(record.user_id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(record.user_id);
}

function loginLocalUser(email, password, res) {
  const normalizedEmail = normalizeEmail(email);
  const identity = db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').get(localIdentityProvider, normalizedEmail);
  if (!identity) {
    throw new Error('No local account matches that email address.');
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(identity.user_id);
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    throw new Error('Invalid email or password.');
  }
  if (!user.email_verified_at) {
    throw new Error('Please confirm your email address before signing in.');
  }

  const membership = db.prepare('SELECT organization_id FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1').get(user.id);
  if (!membership) {
    throw new Error('This account is not associated with a workspace yet.');
  }

  const csrf = createSession(user.id, membership.organization_id, res);
  return { user, organizationId: membership.organization_id, csrf };
}

function writeUserCredentials(userId, provider, values) {
  const normalizedProvider = normalizeProviderKey(provider);
  if (!normalizedProvider || typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new Error('Credential payload must be an object for a valid provider.');
  }
  const now = new Date().toISOString();
  const existing = db.prepare(`
    SELECT encrypted_value FROM user_credentials WHERE user_id = ? AND provider = ?
  `).get(userId, normalizedProvider);
  const previousValues = existing ? decrypt(existing.encrypted_value) : {};
  const encryptedValue = encrypt({ ...previousValues, ...values });
  db.prepare(`
    INSERT INTO user_credentials (user_id, provider, encrypted_value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      encrypted_value = excluded.encrypted_value,
      updated_at = excluded.updated_at
  `).run(userId, normalizedProvider, encryptedValue, now, now);
  return { provider: normalizedProvider, saved: true, updated_at: now };
}

function readUserCredentials(userId) {
  const rows = db.prepare('SELECT provider, encrypted_value, updated_at FROM user_credentials WHERE user_id = ? ORDER BY provider')
    .all(userId);
  return rows.map((row) => ({
    provider: row.provider,
    values: decrypt(row.encrypted_value),
    updated_at: row.updated_at
  }));
}

function deleteUserCredentials(userId, provider) {
  const normalizedProvider = normalizeProviderKey(provider);
  const deleted = db.prepare('DELETE FROM user_credentials WHERE user_id = ? AND provider = ?').run(userId, normalizedProvider);
  return { deleted: deleted.changes > 0, provider: normalizedProvider };
}

function createSession(userId, organizationId, res) {
  const token = randomToken();
  const csrf = csrfTokenForSession(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionLifetimeMs).toISOString();
  db.prepare(`
    INSERT INTO sessions (token_hash, csrf_hash, user_id, organization_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sha256(token), sha256(csrf), userId, organizationId, expiresAt, now.toISOString());
  res.append('Set-Cookie', cookieHeader(sessionCookieName, token, {
    sameSite: 'None',
    maxAge: Math.floor(sessionLifetimeMs / 1000),
    secure: true
  }));
  return csrf;
}

function storeIntegration(organizationId, userId, provider, profile, tokens, metadata = {}) {
  const now = new Date().toISOString();
  const existing = db.prepare(`
    SELECT encrypted_tokens FROM integrations
    WHERE organization_id = ? AND provider = ? AND external_account_id = ?
  `).get(organizationId, provider, profile.subject);
  const oldTokens = existing ? decrypt(existing.encrypted_tokens) : {};
  const mergedTokens = { ...oldTokens, ...tokens };
  if (provider !== 'slack' && !mergedTokens.refresh_token) {
    throw new Error(`${provider} did not return a refresh token. Remove the prior grant from provider settings and reconnect with offline access enabled.`);
  }
  db.prepare(`
    INSERT INTO integrations
      (organization_id, user_id, provider, external_account_id, display_name, email, encrypted_tokens, metadata, connected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, provider, external_account_id) DO UPDATE SET
      user_id = excluded.user_id,
      display_name = excluded.display_name,
      email = excluded.email,
      encrypted_tokens = excluded.encrypted_tokens,
      updated_at = excluded.updated_at
  `).run(
    organizationId,
    userId,
    provider,
    profile.subject,
    profile.name,
    profile.email,
    encrypt(mergedTokens),
    JSON.stringify({ ...(profile.metadata || {}), ...metadata }),
    existing ? now : now,
    now
  );
}

function finalizeOAuthLogin(userId, organizationId, res) {
  const csrf = createSession(userId, organizationId, res);
  res.append('Set-Cookie', clearCookieHeader(oauthCookieName));
  return csrf;
}

function authenticate(req, _res, next) {
  const cookies = readCookies(req);
  const authorization = req.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
  const token = bearer || cookies[sessionCookieName];
  if (!token) return next();

  const session = db.prepare(`
    SELECT s.*, u.name, u.email, m.role, m.organization_role, o.name AS organization_name
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN memberships m ON m.organization_id = s.organization_id AND m.user_id = s.user_id
    JOIN organizations o ON o.id = s.organization_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(sha256(token), new Date().toISOString());
  if (session) req.auth = { ...session, tokenHash: sha256(token), rawToken: token, bearer: Boolean(bearer) };
  next();
}

function requireAuthentication(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

function requireCsrf(req, res, next) {
  if (req.auth.bearer) return next();
  const supplied = req.get('X-CSRF-Token');
  if (!supplied || !constantTimeEqual(sha256(supplied), req.auth.csrf_hash)) {
    return res.status(403).json({ error: 'CSRF validation failed. Refresh your session and retry.' });
  }
  next();
}

function getCurrentAccount(req) {
  const { tokenHash, rawToken, csrf_hash: csrfHash, bearer, expires_at: expiresAt, ...account } = req.auth;
  const subscription = db.prepare('SELECT plan, status FROM subscriptions WHERE organization_id = ?')
    .get(account.organization_id);
  const usage = db.prepare(`
    SELECT COALESCE(SUM(units), 0) AS units
    FROM usage_events WHERE organization_id = ? AND created_at >= ?
  `).get(account.organization_id, new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString());
  return {
    user: { id: account.user_id, name: account.name, email: account.email },
    workspace: {
      id: account.organization_id,
      name: account.organization_name,
      role: account.organization_role || 'product_owner',
      platform_role: account.role
    },
    subscription: subscription || { plan: 'free', status: 'active' },
    usage: { units_this_month: usage.units },
    csrf_token: req.auth.bearer ? null : csrfTokenForSession(rawToken)
  };
}

function listOrganizationMembers(organizationId) {
  return db.prepare(`
    SELECT u.id, u.name, u.email, m.role AS platform_role,
      m.organization_role AS role, m.created_at AS joined_at
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ? ORDER BY m.created_at, u.name
  `).all(organizationId);
}

function updateOrganizationMemberRole(organizationId, userId, role) {
  if (!organizationRoles.includes(role)) {
    throw new Error(`Role must be one of: ${organizationRoles.join(', ')}.`);
  }
  const update = db.transaction(() => {
    const member = db.prepare(`
      SELECT organization_role FROM memberships WHERE organization_id = ? AND user_id = ?
    `).get(organizationId, userId);
    if (!member) throw new Error('User is not a member of this organization.');
    if (member.organization_role === 'company_admin' && role !== 'company_admin') {
      const admins = db.prepare(`
        SELECT COUNT(*) AS count FROM memberships
        WHERE organization_id = ? AND organization_role = 'company_admin'
      `).get(organizationId).count;
      if (admins <= 1) throw new Error('An organization must retain at least one Company Admin.');
    }
    db.prepare(`
      UPDATE memberships SET organization_role = ?
      WHERE organization_id = ? AND user_id = ?
    `).run(role, organizationId, userId);
  });
  update.immediate();
  return { user_id: userId, role };
}

function createWorkspace(name, userId) {
  const safeName = typeof name === 'string' ? name.trim().slice(0, 100) : '';
  if (safeName.length < 2) throw new Error('Workspace name must be at least 2 characters.');
  const id = createId();
  const now = new Date().toISOString();
  const create = db.transaction(() => {
    db.prepare('INSERT INTO organizations (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(id, safeName, userId, now);
    db.prepare(`
      INSERT INTO memberships (organization_id, user_id, role, organization_role, created_at)
      VALUES (?, ?, 'owner', 'company_admin', ?)
    `).run(id, userId, now);
    db.prepare('INSERT INTO subscriptions (organization_id, updated_at) VALUES (?, ?)')
      .run(id, now);
  });
  create();
  return { id, name: safeName, role: 'owner' };
}

function issueInvitation(organizationId, userId, email, role) {
  const membership = db.prepare('SELECT organization_role FROM memberships WHERE organization_id = ? AND user_id = ?')
    .get(organizationId, userId);
  if (!membership || membership.organization_role !== 'company_admin') {
    throw new Error('Only Company Admins can invite members.');
  }
  if (!['admin', 'member'].includes(role)) throw new Error('Invite role must be admin or member.');
  if (email && (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('Invitation email address is invalid.');
  }
  const token = randomToken();
  const now = new Date();
  db.prepare(`
    INSERT INTO invitations (token_hash, organization_id, email, role, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sha256(token), organizationId, email?.trim().toLowerCase() || null, role,
    new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), now.toISOString());
  return { token, expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString() };
}

function acceptInvitation(token, user) {
  if (typeof token !== 'string' || token.length < 40) throw new Error('Invitation token is invalid.');
  const row = db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(sha256(token));
  if (!row || new Date(row.expires_at) <= new Date()) throw new Error('Invitation is invalid or expired.');
  if (row.email && row.email !== user.email?.toLowerCase()) {
    throw new Error('Sign in with the email address this invitation was sent to.');
  }
  db.prepare(`
    INSERT OR IGNORE INTO memberships (organization_id, user_id, role, organization_role, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    row.organization_id,
    user.id,
    row.role,
    row.role === 'admin' ? 'company_admin' : 'product_owner',
    new Date().toISOString()
  );
  db.prepare('DELETE FROM invitations WHERE token_hash = ?').run(row.token_hash);
  return db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(row.organization_id);
}

module.exports = {
  db,
  providers,
  sessionCookieName,
  oauthCookieName,
  publicBaseUrl,
  createAuthorization,
  consumeOAuthState,
  exchangeCode,
  loadProfile,
  findOrCreateAccount,
  createSession,
  finalizeOAuthLogin,
  storeIntegration,
  authenticate,
  requireAuthentication,
  requireCsrf,
  getCurrentAccount,
  createWorkspace,
  issueInvitation,
  acceptInvitation,
  listOrganizationMembers,
  updateOrganizationMemberRole,
  organizationRoles,
  registerLocalUser,
  sendEmailVerification,
  verifyEmailToken,
  loginLocalUser,
  writeUserCredentials,
  readUserCredentials,
  deleteUserCredentials,
  normalizeEmail,
  hashPassword,
  verifyPassword,
  readCookies,
  constantTimeEqual,
  csrfTokenForSession,
  clearCookieHeader,
  encrypt,
  decrypt,
  sha256,
  createId
};
