const fs = require('node:fs/promises');

const TOKEN_EXCHANGE_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_API_ORIGIN = 'https://api.openai.com';
const TOKEN_EXPIRY_BUFFER_SECONDS = 30;

function getWorkloadIdentityConfig(env = process.env) {
  const keys = [
    'OPENAI_IDENTITY_PROVIDER_ID',
    'OPENAI_SERVICE_ACCOUNT_ID',
    'OPENAI_IDENTITY_TOKEN_FILE'
  ];
  const configured = keys.filter((key) => env[key]);
  if (configured.length === 0) return null;

  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`OpenAI workload identity is incomplete. Configure: ${missing.join(', ')}.`);
  }

  return {
    identityProviderId: env.OPENAI_IDENTITY_PROVIDER_ID,
    serviceAccountId: env.OPENAI_SERVICE_ACCOUNT_ID,
    identityTokenFile: env.OPENAI_IDENTITY_TOKEN_FILE
  };
}

function createWorkloadIdentityTokenProvider({
  config,
  fetchImpl = globalThis.fetch,
  readTokenFile = (filePath) => fs.readFile(filePath, 'utf8'),
  now = Date.now
}) {
  let cachedToken = null;
  let expiresAt = 0;
  let exchangePromise = null;

  return async function getAccessToken() {
    const nowSeconds = Math.floor(now() / 1000);
    if (cachedToken && expiresAt > nowSeconds + TOKEN_EXPIRY_BUFFER_SECONDS) {
      return cachedToken;
    }
    if (exchangePromise) return exchangePromise;

    exchangePromise = (async () => {
      const subjectToken = (await readTokenFile(config.identityTokenFile)).trim();
      if (!subjectToken) {
        throw new Error('Render provided an empty OpenAI workload identity token.');
      }

      const response = await fetchImpl(TOKEN_EXCHANGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
          subject_token: subjectToken,
          identity_provider_id: config.identityProviderId,
          service_account_id: config.serviceAccountId
        }),
        signal: AbortSignal.timeout(10000)
      });
      const payload = await response.json();
      if (!response.ok) {
        const reason = payload.error_description || payload.error || 'request rejected';
        throw new Error(`OpenAI workload identity token exchange failed (${response.status}): ${reason}.`);
      }
      if (typeof payload.access_token !== 'string' || !payload.access_token) {
        throw new Error('OpenAI workload identity token exchange returned no access token.');
      }

      const responseExpiry = Number(payload.expires_at);
      const lifetime = Number(payload.expires_in);
      const nextExpiry = Number.isFinite(responseExpiry) && responseExpiry > 0
        ? responseExpiry
        : nowSeconds + lifetime;
      if (!Number.isFinite(nextExpiry) || nextExpiry <= nowSeconds) {
        throw new Error('OpenAI workload identity token exchange returned an invalid expiration.');
      }

      cachedToken = payload.access_token;
      expiresAt = nextExpiry;
      return cachedToken;
    })();

    try {
      return await exchangePromise;
    } finally {
      exchangePromise = null;
    }
  };
}

function createWorkloadIdentityFetch({ getAccessToken, fetchImpl = globalThis.fetch }) {
  return async function workloadIdentityFetch(input, init = {}) {
    const requestUrl = typeof input === 'string' || input instanceof URL
      ? new URL(input)
      : new URL(input.url);
    if (requestUrl.origin !== OPENAI_API_ORIGIN) {
      throw new Error('OpenAI workload identity can only authenticate requests to api.openai.com.');
    }

    const headers = new Headers(input?.headers);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    headers.set('Authorization', `Bearer ${await getAccessToken()}`);
    return fetchImpl(input, { ...init, headers });
  };
}

let defaultProvider;
let defaultProviderConfig;

function getDefaultTokenProvider(config) {
  if (
    !defaultProvider ||
    defaultProviderConfig.identityProviderId !== config.identityProviderId ||
    defaultProviderConfig.serviceAccountId !== config.serviceAccountId ||
    defaultProviderConfig.identityTokenFile !== config.identityTokenFile
  ) {
    defaultProviderConfig = config;
    defaultProvider = createWorkloadIdentityTokenProvider({ config });
  }
  return defaultProvider;
}

async function getManagedOpenAIAuthToken(env = process.env) {
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY;
  const config = getWorkloadIdentityConfig(env);
  if (!config) return null;
  return getDefaultTokenProvider(config)();
}

function createOpenAIClient(OpenAI, env = process.env) {
  if (env.OPENAI_API_KEY) {
    return new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }

  const config = getWorkloadIdentityConfig(env);
  if (!config) return null;

  return new OpenAI({
    apiKey: 'render-workload-identity',
    fetch: createWorkloadIdentityFetch({ getAccessToken: getDefaultTokenProvider(config) })
  });
}

function hasManagedOpenAIAuth(env = process.env) {
  return Boolean(env.OPENAI_API_KEY || getWorkloadIdentityConfig(env));
}

module.exports = {
  createOpenAIClient,
  createWorkloadIdentityFetch,
  createWorkloadIdentityTokenProvider,
  getManagedOpenAIAuthToken,
  getWorkloadIdentityConfig,
  hasManagedOpenAIAuth
};
