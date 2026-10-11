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
      window.location.href = '/profile.html';
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
      setStatus('Account created. Redirecting to your profile…');
      window.location.href = '/profile.html';
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

    document.getElementById('googleDrive').onclick = () => {
      location.href = '/auth/google/start?flow=connect';
    };
    document.getElementById('jira').onclick = () => {
      location.href = '/auth/atlassian/start?flow=connect';
    };
    document.getElementById('slack').onclick = () => {
      location.href = '/auth/slack/start?flow=connect';
    };
    document.getElementById('zoom').onclick = () => {
      location.href = '/auth/zoom/start?flow=connect';
    };
    document.getElementById('teams').onclick = () => {
      location.href = '/auth/microsoft/start?flow=connect';
    };
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
          location.href = (await request('/api/billing/credits/checkout', 'POST', {})).url;
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
