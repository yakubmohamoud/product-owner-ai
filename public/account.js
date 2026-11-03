let csrf = '';
const message = document.getElementById('message');

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

function setStatus(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? '#b42318' : '#172033';
}

function attachLocalAuthHandlers() {
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');

  loginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      email: document.getElementById('loginEmail').value,
      password: document.getElementById('loginPassword').value
    };
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Email/password sign-in failed.');
      csrf = data.csrf_token || '';
      setStatus('Signed in successfully. Redirecting to your workspace…');
      window.location.href = '/';
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  registerForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      name: document.getElementById('registerName').value,
      email: document.getElementById('registerEmail').value,
      password: document.getElementById('registerPassword').value
    };
    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Account creation failed.');
      csrf = data.csrf_token || '';
      setStatus('Account created. Redirecting to your workspace…');
      window.location.href = '/';
    } catch (error) {
      setStatus(error.message, true);
    }
  });
}

async function loadOrganizationMembers(account) {
  const section = document.getElementById('organizationRoles');
  section.hidden = !['company_admin', 'head_of_product'].includes(account.workspace.role);
  if (section.hidden) return;

  const result = await request('/api/workspaces/members');
  const container = document.getElementById('organizationMembers');
  container.replaceChildren();
  for (const member of result.members) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:10px 0;';
    const identity = document.createElement('span');
    identity.textContent = `${member.name} (${member.email || 'No email'})`;
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Role for ${member.name}`);
    for (const role of result.roles) {
      const option = document.createElement('option');
      option.value = role;
      option.textContent = role.replaceAll('_', ' ');
      option.selected = role === member.role;
      select.appendChild(option);
    }
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Update role';
    save.disabled = account.workspace.role !== 'company_admin';
    save.addEventListener('click', async () => {
      try {
        await request(`/api/workspaces/members/${encodeURIComponent(member.id)}/role`, 'PUT', {
          role: select.value
        });
        if (member.id === account.user.id && select.value !== 'company_admin') {
          location.reload();
          return;
        }
        setStatus(`Updated ${member.name}'s organization role.`);
        await loadOrganizationMembers(account);
      } catch (error) {
        setStatus(error.message, true);
      }
    });
    row.append(identity, select, save);
    container.appendChild(row);
  }
}

async function start() {
  const params = new URLSearchParams(location.search);
  if (params.has('auth_error')) setStatus(params.get('auth_error'), true);
  else if (params.has('signed_in')) setStatus('Signed in successfully.');
  else if (params.has('connected')) setStatus('Integration connected.');
  else if (params.has('billing')) setStatus(`Billing ${params.get('billing')}.`);

  attachLocalAuthHandlers();

  try {
    const response = await fetch('/api/auth/providers');
    if (!response.ok) throw new Error('Unable to check sign-in configuration.');
    const configured = await response.json();
    const managedCreditConfig = configured.managedCreditConfig || {};
    document.getElementById('googleLogin').hidden = !configured.google;
    document.getElementById('atlassianLogin').hidden = !configured.atlassian;
    for (const [buttonId, enabled] of [
      ['byok', configured.prices.byok],
      ['byokPlan', configured.prices.byok],
      ['credits', configured.prices.managedCredits],
      ['managedCredits', configured.prices.managedCredits],
      ['team', configured.prices.team],
      ['business', configured.prices.business],
      ['payg', configured.prices.payg]
    ]) {
      const button = document.getElementById(buttonId);
      if (button) button.disabled = !enabled;
    }

    const account = await request('/api/auth/me');
    csrf = account.csrf_token || '';
    document.getElementById('login').hidden = true;
    document.getElementById('account').hidden = false;
    document.getElementById('logout').hidden = false;
    document.getElementById('accountName').textContent = account.user.name;
    document.getElementById('accountEmail').textContent = account.user.email || 'Atlassian account';
    document.getElementById('workspace').textContent = account.workspace.name;
    document.getElementById('plan').textContent = account.subscription.plan;
    const billingSummary = await request('/api/billing/usage');
    document.getElementById('billingModeSummary').textContent = billingSummary.billing.mode;
    document.getElementById('usage').textContent = billingSummary.token_usage.total_tokens;
    const billingControls = document.getElementById('billingControls');
    billingControls.hidden = account.workspace.role !== 'company_admin';
    if (!billingControls.hidden) {
      document.getElementById('billingMode').textContent = billingSummary.billing.mode;
      document.getElementById('creditBalance').textContent =
        (billingSummary.billing.balance_micro_usd / 1_000_000).toFixed(2);
      document.getElementById('billingModeSelect').value = billingSummary.billing.mode;
    }
    await loadOrganizationMembers(account);
    setStatus('Your workspace is ready.');

    document.getElementById('googleDrive')?.addEventListener('click', () => {
      location.href = '/auth/google/start?flow=connect';
    });
    document.getElementById('jira').onclick = () => {
      location.href = '/auth/atlassian/start?flow=connect';
    };
    try {
      const integrations = await request('/api/integrations');
      if (integrations.integrations?.some((integration) => integration.provider === 'atlassian')) {
        document.getElementById('atlassianStatus').textContent = 'Jira and Confluence are connected.';
      }
    } catch (_) { /* Integration status is optional. */ }
    document.getElementById('openaiKeyForm').addEventListener('submit', async (event) => {
      event.preventEvent?.();
      event.preventDefault();
      try {
        const value = document.getElementById('openaiKey').value.trim();
        if (!value) throw new Error('Enter an OpenAI API key.');
        await request('/api/profile/credentials', 'POST', { provider: 'openai', values: { api_key: value } });
        document.getElementById('openaiKey').value = '';
        document.getElementById('openaiKey').placeholder = 'Saved securely; enter to replace';
        setStatus('OpenAI provider key saved securely.');
      } catch (error) {
        setStatus(error.message, true);
      }
    });
    const creditAmount = document.getElementById('creditAmount');
    const creditCurrency = document.getElementById('creditCurrency');
    const updateEstimate = () => {
      const configuredRates = managedCreditConfig.exchange_rates_usd_per_unit || { gbp: 1.27, usd: 1, eur: 1.08 };
      const amount = Math.max(0, Number(creditAmount.value) || 0);
      const dollars = amount * (configuredRates[creditCurrency.value.toLowerCase()] || 1);
      document.getElementById('estimatedDocs').textContent = `~${Math.max(0, Math.round(dollars / 2.5))} documents`;
      document.getElementById('estimatedMinutes').textContent = `~${Math.max(0, Math.round(dollars * 10))} meeting minutes`;
      const markupBps = Number(managedCreditConfig.markup_basis_points || 3000);
      const markupUsd = dollars * markupBps / (10_000 + markupBps);
      const currencyRate = configuredRates[creditCurrency.value.toLowerCase()] || 1;
      const processorFeeUsd = (amount * 0.029 + 0.30) * currencyRate;
      const symbol = { GBP: '£', USD: '$', EUR: '€' }[creditCurrency.value];
      document.getElementById('creditPurchaseEstimate').textContent =
        `Credit value: $${dollars.toFixed(2)} USD (${symbol}${amount.toFixed(2)}). Estimated markup revenue: $${markupUsd.toFixed(2)} USD; estimated Stripe fee: $${processorFeeUsd.toFixed(2)} USD; estimated net before tax: $${(markupUsd - processorFeeUsd).toFixed(2)} USD.`;
    };
    creditCurrency.addEventListener('change', () => {
      const limits = { GBP: 8000, USD: 10000, EUR: 9000 };
      creditAmount.max = limits[creditCurrency.value];
      updateEstimate();
    });
    creditAmount.addEventListener('input', updateEstimate);
    updateEstimate();
    document.getElementById('manageBilling').onclick = async () => {
      try {
        location.href = (await request('/api/billing/portal', 'POST', {})).url;
      } catch (error) {
        setStatus(error.message, true);
      }
    };
    document.getElementById('saveBillingMode').onclick = async () => {
      try {
        const selectedMode = document.getElementById('billingModeSelect').value;
        const billing = await request('/api/billing/mode', 'PUT', { mode: selectedMode });
        document.getElementById('billingMode').textContent = billing.mode;
        setStatus(`AI billing mode set to ${billing.mode}.`);
      } catch (error) {
        setStatus(error.message, true);
      }
    };
    for (const buttonId of ['byok', 'byokPlan']) {
      const button = document.getElementById(buttonId);
      if (!button) continue;
      button.onclick = async () => {
        try {
          location.href = (await request('/api/billing/checkout', 'POST', { plan: 'byok' })).url;
        } catch (error) {
          setStatus(error.message, true);
        }
      };
    }
    for (const buttonId of ['credits', 'managedCredits']) {
      const button = document.getElementById(buttonId);
      if (!button) continue;
      button.onclick = async () => {
        try {
          const amount = Number(document.getElementById('creditAmount')?.value);
          const currency = String(document.getElementById('creditCurrency')?.value || 'GBP').toLowerCase();
          location.href = (await request('/api/billing/credits/checkout', 'POST', { amount, currency })).url;
        } catch (error) {
          setStatus(error.message, true);
        }
      };
    }
    document.getElementById('logout').onclick = async () => {
      try {
        await request('/api/auth/logout', 'POST', {});
        location.reload();
      } catch (error) {
        setStatus(error.message, true);
      }
    };
    for (const plan of ['team', 'business', 'payg']) {
      const button = document.getElementById(plan);
      if (!button) continue;
      button.onclick = async () => {
        try {
          location.href = (await request('/api/billing/checkout', 'POST', { plan })).url;
        } catch (error) {
          setStatus(error.message, true);
        }
      };
    }
  } catch (error) {
    setStatus(`${message.textContent}\n${error.message}`, true);
  }
}

start();
