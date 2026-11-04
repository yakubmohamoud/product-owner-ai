const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const dataDirectory = path.resolve(process.env.DATA_DIRECTORY || path.join(__dirname, '..', '..', '.data'));
fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
fs.chmodSync(dataDirectory, 0o700);

function loadApplicationSecret() {
  if (process.env.APP_SECRET) {
    if (process.env.APP_SECRET.length < 32) {
      throw new Error('APP_SECRET must be at least 32 characters long.');
    }
    return process.env.APP_SECRET;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_SECRET must be set to a randomly generated value of at least 32 characters in production.');
  }

  const secretPath = path.join(dataDirectory, '.development-secret');
  if (!fs.existsSync(secretPath)) {
    fs.writeFileSync(secretPath, crypto.randomBytes(48).toString('base64url'), { mode: 0o600, flag: 'wx' });
  }
  fs.chmodSync(secretPath, 0o600);
  return fs.readFileSync(secretPath, 'utf8');
}

const applicationSecret = loadApplicationSecret();
const encryptionKey = crypto.hkdfSync(
  'sha256',
  Buffer.from(applicationSecret),
  Buffer.from('product-owner-ai'),
  Buffer.from('oauth-token-encryption-v1'),
  32
);

const databasePath = path.resolve(process.env.DATABASE_PATH || path.join(dataDirectory, 'product-owner-ai.sqlite'));
const db = new Database(databasePath);
fs.chmodSync(databasePath, 0o600);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    password_hash TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    organization_role TEXT NOT NULL DEFAULT 'product_owner'
      CHECK (organization_role IN ('company_admin', 'product_owner', 'scrum_master', 'head_of_product')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (provider, subject)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS identities_provider_subject ON identities(provider, subject);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_hash TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY,
    cookie_hash TEXT NOT NULL,
    provider TEXT NOT NULL,
    flow TEXT NOT NULL CHECK (flow IN ('login', 'connect')),
    verifier TEXT NOT NULL,
    nonce TEXT,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
    return_to TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS integrations (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_account_id TEXT NOT NULL,
    display_name TEXT,
    email TEXT,
    encrypted_tokens TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    connected_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, provider, external_account_id)
  );
  CREATE TABLE IF NOT EXISTS invitations (
    token_hash TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT UNIQUE,
    plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    event_type TEXT NOT NULL,
    units INTEGER NOT NULL CHECK (units > 0),
    billable INTEGER NOT NULL DEFAULT 1 CHECK (billable IN (0, 1)),
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_org_date ON usage_events(organization_id, created_at);
  CREATE TABLE IF NOT EXISTS stripe_events (
    event_id TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS billing_outbox (
    usage_event_id TEXT PRIMARY KEY REFERENCES usage_events(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS standup_schedules (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    send_time TEXT NOT NULL,
    timezone TEXT NOT NULL,
    slack_user_ids TEXT NOT NULL,
    jira_site_id TEXT,
    jira_issue_key TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    last_sent_day TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS standup_deliveries (
    schedule_id TEXT NOT NULL REFERENCES standup_schedules(id) ON DELETE CASCADE,
    day_key TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    prompt_ts TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (schedule_id, day_key, slack_user_id)
  );
  CREATE TABLE IF NOT EXISTS standup_submissions (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES standup_schedules(id) ON DELETE CASCADE,
    day_key TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    encrypted_content TEXT NOT NULL,
    external_message_ts TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS webhook_events (
    provider TEXT NOT NULL,
    event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (provider, event_id)
  );
  CREATE TABLE IF NOT EXISTS user_credentials (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, provider)
  );
  CREATE TABLE IF NOT EXISTS billing_accounts (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'managed' CHECK (mode IN ('byok', 'managed')),
    balance_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (balance_micro_usd >= 0),
    reserved_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS billing_ledger (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('credit', 'debit', 'refund')),
    amount_micro_usd INTEGER NOT NULL CHECK (amount_micro_usd > 0),
    reference_id TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (organization_id, entry_type, reference_id)
  );
  CREATE TABLE IF NOT EXISTS billing_reservations (
    request_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    remaining_micro_usd INTEGER NOT NULL CHECK (remaining_micro_usd >= 0),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count >= 0)
  );
  CREATE TABLE IF NOT EXISTS llm_usage (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    request_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
    input_rate_micro_usd_per_million INTEGER NOT NULL CHECK (input_rate_micro_usd_per_million >= 0),
    output_rate_micro_usd_per_million INTEGER NOT NULL CHECK (output_rate_micro_usd_per_million >= 0),
    cost_micro_usd INTEGER NOT NULL CHECK (cost_micro_usd >= 0),
    charged_micro_usd INTEGER NOT NULL CHECK (charged_micro_usd >= 0),
    billing_mode TEXT NOT NULL CHECK (billing_mode IN ('byok', 'managed')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS llm_usage_org_date ON llm_usage(organization_id, created_at);
`);

const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns.some((column) => column.name === 'password_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT;');
}
if (!userColumns.some((column) => column.name === 'email_verified_at')) {
  db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT;');
}
db.prepare("UPDATE users SET email_verified_at = ? WHERE email_verified_at IS NULL AND password_hash IS NOT NULL AND created_at < ?").run(new Date().toISOString(), '2026-11-04T00:00:00.000Z');
db.exec(`
  CREATE TABLE IF NOT EXISTS email_verification_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const membershipColumns = db.prepare('PRAGMA table_info(memberships)').all();
if (!membershipColumns.some((column) => column.name === 'organization_role')) {
  db.exec(`
    ALTER TABLE memberships ADD COLUMN organization_role TEXT NOT NULL DEFAULT 'product_owner'
      CHECK (organization_role IN ('company_admin', 'product_owner', 'scrum_master', 'head_of_product'));
    UPDATE memberships SET organization_role = 'company_admin' WHERE role IN ('owner', 'admin');
  `);
}
db.prepare(`
  INSERT OR IGNORE INTO billing_accounts (organization_id, updated_at)
  SELECT id, ? FROM organizations
`).run(new Date().toISOString());
db.exec(`
  UPDATE billing_accounts SET mode = 'managed'
  WHERE mode = 'byok' AND organization_id IN (
    SELECT b.organization_id FROM billing_accounts b
    LEFT JOIN subscriptions s ON s.organization_id = b.organization_id
    WHERE s.plan IS NULL OR s.plan <> 'byok'
  );
`);

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decrypt(value) {
  const [iv, authTag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(authTag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createId() {
  return crypto.randomUUID();
}

module.exports = {
  db,
  encrypt,
  decrypt,
  sha256,
  createId,
  dataDirectory
};
