const statusEl = document.getElementById('status');
const loggedInEl = document.getElementById('loggedIn');
const loggedOutEl = document.getElementById('loggedOut');
const credentialsSection = document.getElementById('credentialsSection');
const formsEl = document.getElementById('credentialForms');
let csrf = '';

const providers = [
  {
    key: 'jira',
    label: 'Jira',
    fields: [
      { name: 'site_url', label: 'Jira site URL' },
      { name: 'email', label: 'Email or username' },
      { name: 'api_token', label: 'API token or PAT', type: 'password' }
    ]
  },
  {
    key: 'openai',
    label: 'OpenAI',
    fields: [
      { name: 'api_key', label: 'API key', type: 'password' },
      { name: 'default_model', label: 'Default model' }
    ]
  },
  {
    key: 'gemini',
    label: 'Gemini',
    fields: [
      { name: 'api_key', label: 'API key', type: 'password' },
      { name: 'default_model', label: 'Default model' }
    ]
  },
  {
    key: 'copilot',
    label: 'Microsoft Copilot',
    fields: [
      { name: 'endpoint', label: 'Endpoint URL' },
      { name: 'api_key', label: 'API key', type: 'password' }
    ]
  },
  {
    key: 'figma',
    label: 'Figma',
    fields: [
      { name: 'personal_access_token', label: 'Personal access token', type: 'password' },
      { name: 'team_id', label: 'Team ID (optional)' }
    ]
  },
  {
    key: 'google_drive',
    label: 'Google Drive',
    fields: [
      { name: 'service_account_email', label: 'Service account email' },
      { name: 'private_key', label: 'Private key / JSON', type: 'textarea' }
    ]
  }
];

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b42318' : '#596579';
}

async function request(path, method = 'GET', body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
  return data;
}

function buildCredentialFields(provider, storedValues = {}, configuredSecretFields = []) {
  const wrapper = document.createElement('div');
  wrapper.className = 'credential-card';

  const title = document.createElement('h3');
  title.textContent = provider.label;
  wrapper.appendChild(title);

  const form = document.createElement('form');
  form.dataset.provider = provider.key;

  for (const field of provider.fields) {
    const label = document.createElement('label');
    label.textContent = field.label;

    let input;
    if (field.type === 'textarea') {
      input = document.createElement('textarea');
      input.value = storedValues[field.name] || '';
    } else {
      input = document.createElement('input');
      input.type = field.type || 'text';
      input.value = storedValues[field.name] || '';
    }
    input.name = field.name;
    const isConfiguredSecret = configuredSecretFields.includes(field.name);
    input.placeholder = isConfiguredSecret ? 'Saved securely; leave blank to keep current value' : field.label;
    if (isConfiguredSecret) input.setAttribute('aria-description', 'A secret is already saved. Leave this empty to keep it.');
    label.appendChild(input);
    form.appendChild(label);
  }

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.textContent = 'Save credentials';
  form.appendChild(saveButton);

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'secondary danger';
  deleteButton.textContent = 'Delete';
  deleteButton.addEventListener('click', async () => {
    try {
      await request(`/api/profile/credentials/${provider.key}`, 'DELETE', {});
      form.reset();
      setStatus(`${provider.label} credentials removed.`);
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  form.appendChild(deleteButton);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = {};
    for (const field of provider.fields) {
      const input = form.elements[field.name];
      if (input && input.value.trim() !== '') values[field.name] = input.value.trim();
    }
    if (Object.keys(values).length === 0) {
      setStatus(`Add at least one value for ${provider.label}.`, true);
      return;
    }
    try {
      await request('/api/profile/credentials', 'POST', { provider: provider.key, values });
      for (const field of provider.fields) {
        if (!/key|token|secret|private|password|credential/i.test(field.name)) continue;
        const input = form.elements[field.name];
        if (!input) continue;
        input.value = '';
        input.placeholder = 'Saved securely; leave blank to keep current value';
      }
      setStatus(`${provider.label} credentials saved.`);
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  wrapper.appendChild(form);
  return wrapper;
}

async function loadProfile() {
  try {
    const account = await request('/api/auth/me');
    csrf = account.csrf_token || '';
    document.getElementById('accountName').textContent = account.user.name;
    document.getElementById('accountEmail').textContent = account.user.email || 'Workspace user';
    loggedInEl.hidden = false;
    credentialsSection.hidden = false;
    setStatus('Profile ready.');

    const credentialData = await request('/api/profile/credentials');
    const valuesByProvider = {};
    const secretFieldsByProvider = {};
    for (const credential of credentialData.credentials || []) {
      valuesByProvider[credential.provider] = credential.values || {};
      secretFieldsByProvider[credential.provider] = credential.configured_secret_fields || [];
    }

    for (const provider of providers) {
      formsEl.appendChild(buildCredentialFields(
        provider,
        valuesByProvider[provider.key] || {},
        secretFieldsByProvider[provider.key] || []
      ));
    }
  } catch (error) {
    loggedOutEl.hidden = false;
    setStatus(error.message, true);
  }
}

loadProfile();
