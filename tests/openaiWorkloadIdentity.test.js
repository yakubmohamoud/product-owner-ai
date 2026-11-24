const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createOpenAIClient,
  createWorkloadIdentityFetch,
  createWorkloadIdentityTokenProvider,
  getWorkloadIdentityConfig,
  hasManagedOpenAIAuth
} = require('../backend/services/openaiWorkloadIdentity');

const config = {
  identityProviderId: 'provider-id',
  serviceAccountId: 'service-account-id',
  identityTokenFile: '/identity/token'
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

test('requires complete Render and OpenAI workload identity configuration', () => {
  assert.equal(getWorkloadIdentityConfig({}), null);
  assert.throws(
    () => getWorkloadIdentityConfig({ OPENAI_IDENTITY_PROVIDER_ID: 'provider-id' }),
    /OPENAI_SERVICE_ACCOUNT_ID, OPENAI_IDENTITY_TOKEN_FILE/
  );
  assert.equal(hasManagedOpenAIAuth({ OPENAI_API_KEY: 'test-key' }), true);
  assert.equal(hasManagedOpenAIAuth({
    OPENAI_IDENTITY_PROVIDER_ID: 'provider-id',
    OPENAI_SERVICE_ACCOUNT_ID: 'service-account-id',
    OPENAI_IDENTITY_TOKEN_FILE: '/identity/token'
  }), true);
});

test('creates an OpenAI client with a workload identity fetch implementation', () => {
  class MockOpenAI {
    constructor(options) {
      this.options = options;
    }
  }

  const client = createOpenAIClient(MockOpenAI, {
    OPENAI_IDENTITY_PROVIDER_ID: 'provider-id',
    OPENAI_SERVICE_ACCOUNT_ID: 'service-account-id',
    OPENAI_IDENTITY_TOKEN_FILE: '/identity/token'
  });

  assert.equal(client.options.apiKey, 'render-workload-identity');
  assert.equal(typeof client.options.fetch, 'function');
});

test('exchanges Render identity tokens and reuses the access token until shortly before expiry', async () => {
  let now = 1_000_000;
  let requestCount = 0;
  let requestBody;
  const getAccessToken = createWorkloadIdentityTokenProvider({
    config,
    now: () => now,
    readTokenFile: async (filePath) => {
      assert.equal(filePath, '/identity/token');
      return 'render-jwt\n';
    },
    fetchImpl: async (url, options) => {
      requestCount += 1;
      assert.equal(url, 'https://auth.openai.com/oauth/token');
      requestBody = JSON.parse(options.body);
      return jsonResponse({ access_token: 'openai-access-token', expires_in: 3600 });
    }
  });

  assert.equal(await getAccessToken(), 'openai-access-token');
  now += 60_000;
  assert.equal(await getAccessToken(), 'openai-access-token');
  assert.equal(requestCount, 1);
  assert.deepEqual(requestBody, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    subject_token: 'render-jwt',
    identity_provider_id: 'provider-id',
    service_account_id: 'service-account-id'
  });
});

test('coalesces concurrent exchanges and refreshes before the access token expires', async () => {
  let now = 1_000_000;
  let requestCount = 0;
  let tokenVersion = 0;
  const getAccessToken = createWorkloadIdentityTokenProvider({
    config,
    now: () => now,
    readTokenFile: async () => 'render-jwt',
    fetchImpl: async () => {
      requestCount += 1;
      tokenVersion += 1;
      return jsonResponse({ access_token: `access-${tokenVersion}`, expires_in: 60 });
    }
  });

  const firstPair = await Promise.all([getAccessToken(), getAccessToken()]);
  assert.deepEqual(firstPair, ['access-1', 'access-1']);
  assert.equal(requestCount, 1);

  now += 31_000;
  assert.equal(await getAccessToken(), 'access-2');
  assert.equal(requestCount, 2);
});

test('adds the exchanged bearer token only to OpenAI API requests', async () => {
  let requestOptions;
  const workloadFetch = createWorkloadIdentityFetch({
    getAccessToken: async () => 'short-lived-token',
    fetchImpl: async (url, options) => {
      requestOptions = { url, options };
      return { ok: true };
    }
  });

  await workloadFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer render-workload-identity' }
  });
  assert.equal(requestOptions.options.headers.get('Authorization'), 'Bearer short-lived-token');

  await assert.rejects(
    workloadFetch('https://example.com/api'),
    /only authenticate requests to api\.openai\.com/
  );
});

test('does not return an OpenAI token when federation exchange is rejected', async () => {
  const getAccessToken = createWorkloadIdentityTokenProvider({
    config,
    readTokenFile: async () => 'render-jwt',
    fetchImpl: async () => jsonResponse({ error: 'invalid_grant' }, 400)
  });

  await assert.rejects(getAccessToken(), /token exchange failed \(400\): invalid_grant/);
});
