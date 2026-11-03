const API_BASE = 'http://localhost:3000';

const inputText = document.getElementById('inputText');
const generateBtn = document.getElementById('generateBtn');
const exportBtn = document.getElementById('exportBtn');
const resultEl = document.getElementById('result');
const statusBox = document.getElementById('statusBox');
const storyList = document.getElementById('storyList');
const umlOutput = document.getElementById('umlOutput');
const testList = document.getElementById('testList');
const projectName = document.getElementById('projectName');
const projectSummary = document.getElementById('projectSummary');
const projectPhase = document.getElementById('projectPhase');
const productUpdate = document.getElementById('productUpdate');
const brdOutput = document.getElementById('brdOutput');
const productDocsOutput = document.getElementById('productDocsOutput');
const safeArtifacts = document.getElementById('safeArtifacts');
const technicalNotes = document.getElementById('technicalNotes');
const roadmapList = document.getElementById('roadmapList');
const riskList = document.getElementById('riskList');
const documentUpload = document.getElementById('documentUpload');
const apiKeyInput = document.getElementById('apiKey');
const questionInput = document.getElementById('questionInput');
const askBtn = document.getElementById('askBtn');
const answerOutput = document.getElementById('answerOutput');
const agendaTrigger = document.getElementById('agendaTrigger');
const agendaBtn = document.getElementById('agendaBtn');
const agendaOutput = document.getElementById('agendaOutput');
const authStatus = document.getElementById('authStatus');
const signInActions = document.getElementById('signInActions');
const signedInActions = document.getElementById('signedInActions');
const accountName = document.getElementById('accountName');
const accountEmail = document.getElementById('accountEmail');
const workspaceName = document.getElementById('workspaceName');
const planName = document.getElementById('planName');
const usageCount = document.getElementById('usageCount');
const integrationStatus = document.getElementById('integrationStatus');
const workspaceSelect = document.getElementById('workspaceSelect');
const projectPanel = document.getElementById('projectPanel');
const projectSelect = document.getElementById('projectSelect');
const storedContext = document.getElementById('storedContext');
const driveFiles = document.getElementById('driveFiles');
const jiraSite = document.getElementById('jiraSite');
const jiraIssues = document.getElementById('jiraIssues');
const confluenceResults = document.getElementById('confluenceResults');
const standupOutput = document.getElementById('standupOutput');
const zoomRecordings = document.getElementById('zoomRecordings');
const teamsTranscripts = document.getElementById('teamsTranscripts');

let currentStories = [];
let currentAgenda = null;
let currentProjectContext = '';
let latestGeneratedContext = '';
let currentProjectId = '';
let csrfToken = '';
let integrationProviders = new Set();

async function apiRequest(path, options = {}) {
  const method = options.method || 'GET';
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    method,
    headers,
    credentials: 'include'
  });
  if (response.status === 204) return { response, data: null };
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401) {
      signedInActions.classList.add('hidden');
      signInActions.classList.remove('hidden');
      projectPanel.classList.add('hidden');
      authStatus.textContent = data?.error || 'Sign in to use project features.';
    }
    throw new Error(data?.error || `Request failed (${response.status}).`);
  }
  return { response, data };
}

function openAuth(provider, flow) {
  const url = `${API_BASE}/auth/${provider}/start${flow === 'connect' ? '?flow=connect' : ''}`;
  window.open(url, '_blank', 'noopener');
}

async function loadAccount() {
  try {
    const providersResponse = await fetch(`${API_BASE}/api/auth/providers`, { credentials: 'include' });
    if (!providersResponse.ok) throw new Error('API is not available.');
    const configured = await providersResponse.json();
    document.getElementById('googleLogin').onclick = () => openAuth('google', 'login');
    document.getElementById('atlassianLogin').onclick = () => openAuth('atlassian', 'login');
    document.getElementById('googleConnect').onclick = () => openAuth('google', 'connect');
    document.getElementById('atlassianConnect').onclick = () => openAuth('atlassian', 'connect');
    document.getElementById('googleLogin').classList.toggle('disabled-link', !configured.google);
    document.getElementById('atlassianLogin').classList.toggle('disabled-link', !configured.atlassian);

    const { data } = await apiRequest('/api/auth/me');
    csrfToken = data.csrf_token || '';
    authStatus.textContent = 'Signed in';
    signInActions.classList.add('hidden');
    signedInActions.classList.remove('hidden');
    projectPanel.classList.remove('hidden');
    accountName.textContent = data.user.name;
    accountEmail.textContent = data.user.email || 'Atlassian account';
    workspaceName.textContent = data.workspace.name;
    planName.textContent = data.subscription.plan;
    usageCount.textContent = data.usage.billable_units;
    integrationProviders = new Set(data.integrations.map((integration) => integration.provider));
    integrationStatus.textContent = integrationProviders.size
      ? `Connected services: ${[...integrationProviders].join(', ')}`
      : 'No external workspaces are connected yet.';
    document.getElementById('googleConnect').classList.toggle('disabled-link', !configured.google);
    document.getElementById('atlassianConnect').classList.toggle('disabled-link', !configured.atlassian);
    await Promise.all([loadWorkspaces(), loadProjects()]);
    if (integrationProviders.has('atlassian')) await loadJiraSites();
  } catch (error) {
    signedInActions.classList.add('hidden');
    signInActions.classList.remove('hidden');
    projectPanel.classList.add('hidden');
    authStatus.textContent = error.message || 'Sign in with Google or Atlassian to continue.';
  }
}

async function loadWorkspaces() {
  const { data } = await apiRequest('/api/workspaces');
  workspaceSelect.replaceChildren();
  data.workspaces.forEach((workspace) => {
    const option = document.createElement('option');
    option.value = workspace.id;
    option.textContent = `${workspace.name} (${workspace.role})`;
    workspaceSelect.appendChild(option);
  });
}

async function loadProjects(selectedId = currentProjectId) {
  const { data } = await apiRequest('/api/projects');
  projectSelect.replaceChildren();
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'No project selected';
  projectSelect.appendChild(blank);
  data.projects.forEach((project) => {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = `${project.name} (${project.document_count} docs)`;
    projectSelect.appendChild(option);
  });
  if (selectedId && data.projects.some((project) => project.id === selectedId)) {
    projectSelect.value = selectedId;
    await selectProject(selectedId);
  }
}

async function selectProject(projectId) {
  currentProjectId = projectId;
  if (!projectId) {
    currentProjectContext = '';
    latestGeneratedContext = '';
    inputText.value = '';
    storedContext.textContent = '';
    return;
  }
  const { data } = await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/context`);
  currentProjectContext = data.context;
  latestGeneratedContext = '';
  inputText.value = '';
  storedContext.textContent = data.context || 'No project notes saved.';
}

async function createProject() {
  const name = document.getElementById('newProjectName').value.trim();
  try {
    const { data } = await apiRequest('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, context: inputText.value.trim() })
    });
    document.getElementById('newProjectName').value = '';
    inputText.value = '';
    currentProjectId = data.project.id;
    await loadProjects(currentProjectId);
    updateStatus('Project created. Its notes and future imported documents are stored encrypted for this workspace.');
  } catch (error) {
    updateStatus(error.message);
  }
}

async function createWorkspace() {
  const name = document.getElementById('newWorkspaceName').value.trim();
  try {
    const { data } = await apiRequest('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    const selection = await apiRequest('/api/workspaces/current', {
      method: 'PUT',
      body: JSON.stringify({ workspace_id: data.workspace.id })
    });
    void selection;
    document.getElementById('newWorkspaceName').value = '';
    await loadAccount();
    updateStatus(`Workspace "${data.workspace.name}" created.`);
  } catch (error) {
    updateStatus(error.message);
  }
}

async function createInvitation() {
  try {
    const email = document.getElementById('inviteEmail').value.trim();
    const { data } = await apiRequest('/api/workspaces/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: email || undefined, role: 'member' })
    });
    document.getElementById('inviteOutput').textContent =
      `Invite token (share privately; expires ${new Date(data.expires_at).toLocaleDateString()}):\n${data.token}`;
  } catch (error) {
    updateStatus(error.message);
  }
}

async function acceptInvitation() {
  try {
    const token = document.getElementById('invitationToken').value.trim();
    const { data } = await apiRequest('/api/workspaces/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token })
    });
    await apiRequest('/api/workspaces/current', {
      method: 'PUT',
      body: JSON.stringify({ workspace_id: data.workspace.id })
    });
    document.getElementById('invitationToken').value = '';
    currentProjectId = '';
    await loadAccount();
    updateStatus(`Joined workspace "${data.workspace.name}".`);
  } catch (error) {
    updateStatus(error.message);
  }
}

async function startCheckout(plan) {
  try {
    const { data } = await apiRequest('/api/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan })
    });
    window.open(data.url, '_blank', 'noopener');
  } catch (error) {
    updateStatus(error.message);
  }
}

async function openBillingPortal() {
  try {
    const { data } = await apiRequest('/api/billing/portal', {
      method: 'POST',
      body: JSON.stringify({})
    });
    window.open(data.url, '_blank', 'noopener');
  } catch (error) {
    updateStatus(error.message);
  }
}

async function loadJiraSites() {
  try {
    const { data } = await apiRequest('/api/integrations/atlassian/sites');
    jiraSite.replaceChildren();
    data.sites.forEach((site) => {
      const option = document.createElement('option');
      option.value = site.id;
      option.textContent = site.name;
      jiraSite.appendChild(option);
    });
    if (!data.sites.length) jiraSite.appendChild(new Option('No authorized sites', ''));
  } catch (error) {
    updateStatus(error.message);
  }
}

async function searchJiraIssues() {
  try {
    const params = new URLSearchParams({ site_id: jiraSite.value, jql: 'ORDER BY updated DESC' });
    const { data } = await apiRequest(`/api/integrations/jira/issues?${params}`);
    jiraIssues.replaceChildren();
    data.issues.forEach((issue) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = `${issue.key}: ${issue.fields.summary} (${issue.fields.status?.name || 'Unknown'})`;
      button.addEventListener('click', () => {
        inputText.value += `\n\nJira ${issue.key}: ${issue.fields.summary}\nStatus: ${issue.fields.status?.name || 'Unknown'}\nUpdated: ${issue.fields.updated || 'Unknown'}`;
        currentProjectContext = '';
      });
      const comment = document.createElement('input');
      comment.type = 'text';
      comment.placeholder = `Reply with a Jira comment on ${issue.key}`;
      const send = document.createElement('button');
      send.type = 'button';
      send.textContent = 'Post comment';
      send.addEventListener('click', async () => {
        if (!comment.value.trim() || !window.confirm(`Post this comment to Jira issue ${issue.key}?`)) return;
        try {
          await apiRequest(`/api/integrations/jira/issues/${encodeURIComponent(issue.key)}/comments`, {
            method: 'POST',
            body: JSON.stringify({ site_id: jiraSite.value, text: comment.value.trim() })
          });
          comment.value = '';
          updateStatus(`Comment posted to ${issue.key}.`);
        } catch (error) {
          updateStatus(error.message);
        }
      });
      item.append(button, comment, send);
      jiraIssues.appendChild(item);
    });
  } catch (error) {
    updateStatus(error.message);
  }
}

async function searchConfluence() {
  try {
    const params = new URLSearchParams({ site_id: jiraSite.value, q: document.getElementById('confluenceSearch').value });
    const { data } = await apiRequest(`/api/integrations/confluence/search?${params}`);
    confluenceResults.replaceChildren();
    (data.results || []).forEach((page) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = page.title;
      button.addEventListener('click', () => {
        const text = page.body?.view?.value || page.body?.storage?.value || '';
        inputText.value += `\n\nConfluence: ${page.title}\n${text.replace(/<[^>]*>/g, ' ')}`;
        currentProjectContext = '';
      });
      item.appendChild(button);
      confluenceResults.appendChild(item);
    });
  } catch (error) {
    updateStatus(error.message);
  }
}

async function searchDriveFiles() {
  try {
    const params = new URLSearchParams({ q: document.getElementById('driveSearch').value });
    const { data } = await apiRequest(`/api/integrations/google-drive/files?${params}`);
    driveFiles.replaceChildren();
    data.files.forEach((file) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${file.name} (${file.mimeType})`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Import';
      button.disabled = !currentProjectId;
      button.addEventListener('click', async () => {
        try {
          await apiRequest('/api/integrations/google-drive/import', {
            method: 'POST',
            body: JSON.stringify({ project_id: currentProjectId, file_id: file.id })
          });
          await selectProject(currentProjectId);
          await loadProjects(currentProjectId);
          updateStatus(`Imported "${file.name}" into the selected project.`);
        } catch (error) {
          updateStatus(error.message);
        }
      });
      item.append(label, button);
      driveFiles.appendChild(item);
    });
  } catch (error) {
    updateStatus(error.message);
  }
}

async function searchZoomTranscripts() {
  if (!currentProjectId) {
    updateStatus('Select a project before importing transcripts.');
    return;
  }
  try {
    const params = new URLSearchParams({
      from: document.getElementById('zoomFrom').value,
      to: document.getElementById('zoomTo').value
    });
    const { data } = await apiRequest(`/api/integrations/zoom/recordings?${params}`);
    zoomRecordings.replaceChildren();
    data.recordings.forEach((recording) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${recording.topic || 'Meeting'} — ${recording.start_time}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Import transcript';
      button.addEventListener('click', async () => {
        try {
          await apiRequest('/api/integrations/zoom/import', {
            method: 'POST',
            body: JSON.stringify({
              project_id: currentProjectId,
              meeting_id: recording.meeting_uuid || recording.meeting_id,
              file_id: recording.file_id
            })
          });
          await selectProject(currentProjectId);
          await loadProjects(currentProjectId);
          updateStatus('Zoom transcript imported into the selected project.');
        } catch (error) {
          updateStatus(error.message);
        }
      });
      item.append(label, button);
      zoomRecordings.appendChild(item);
    });
  } catch (error) {
    updateStatus(error.message);
  }
}

async function searchTeamsTranscripts() {
  if (!currentProjectId) {
    updateStatus('Select a project before importing transcripts.');
    return;
  }
  const meetingId = document.getElementById('teamsMeetingId').value.trim();
  try {
    const { data } = await apiRequest(
      `/api/integrations/microsoft/meetings/${encodeURIComponent(meetingId)}/transcripts`
    );
    teamsTranscripts.replaceChildren();
    data.transcripts.forEach((transcript) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = transcript.createdDateTime || transcript.id;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Import transcript';
      button.addEventListener('click', async () => {
        try {
          await apiRequest('/api/integrations/microsoft/transcripts/import', {
            method: 'POST',
            body: JSON.stringify({
              project_id: currentProjectId,
              meeting_id: meetingId,
              transcript_id: transcript.id
            })
          });
          await selectProject(currentProjectId);
          await loadProjects(currentProjectId);
          updateStatus('Teams transcript imported into the selected project.');
        } catch (error) {
          updateStatus(error.message);
        }
      });
      item.append(label, button);
      teamsTranscripts.appendChild(item);
    });
  } catch (error) {
    updateStatus(error.message);
  }
}

async function draftStandup() {
  const updates = [{
    member: document.getElementById('standupMember').value,
    yesterday: document.getElementById('standupYesterday').value,
    today: document.getElementById('standupToday').value,
    blockers: document.getElementById('standupBlockers').value
  }];
  try {
    const { data } = await apiRequest('/api/standup-draft', {
      method: 'POST',
      body: JSON.stringify({ updates })
    });
    standupOutput.textContent = `${data.summary.join('\n')}\n\nJira comment draft:\n${data.jira_comment_draft}\n\nReview before posting.`;
  } catch (error) {
    updateStatus(error.message);
  }
}

async function loadSlackMembers() {
  try {
    const { data } = await apiRequest('/api/integrations/slack/members');
    const memberSelect = document.getElementById('slackMembers');
    memberSelect.replaceChildren();
    data.members.forEach((member) => {
      const option = document.createElement('option');
      option.value = member.id;
      option.textContent = member.name;
      memberSelect.appendChild(option);
    });
    updateStatus(`Loaded ${data.members.length} Slack members.`);
  } catch (error) {
    updateStatus(error.message);
  }
}

async function saveStandupSchedule() {
  const memberSelect = document.getElementById('slackMembers');
  const jiraIssue = document.getElementById('standupJiraIssue').value.trim();
  try {
    const { data } = await apiRequest('/api/standup/schedules', {
      method: 'POST',
      body: JSON.stringify({
        send_time: document.getElementById('standupSendTime').value,
        timezone: document.getElementById('standupTimezone').value.trim(),
        slack_user_ids: Array.from(memberSelect.selectedOptions, (option) => option.value),
        jira_site_id: jiraIssue ? jiraSite.value : null,
        jira_issue_key: jiraIssue || null
      })
    });
    document.getElementById('standupScheduleStatus').textContent =
      `Daily Slack check-in scheduled for ${data.member_count} members at ${data.send_time} (${data.timezone}).`;
  } catch (error) {
    updateStatus(error.message);
  }
}

function addTextListItems(list, items, getText) {
  list.replaceChildren();
  (items || []).forEach((item) => {
    const li = document.createElement('li');
    li.textContent = getText(item);
    list.appendChild(li);
  });
}

function updateStatus(message) {
  statusBox.textContent = message;
  statusBox.classList.remove('hidden');
}

function renderResult(data) {
  latestGeneratedContext = `Generated project pack:\n${JSON.stringify(data)}`;
  currentStories = data.user_stories || [];
  projectName.textContent = data.project_name || 'Project';
  projectSummary.textContent = data.project_summary || '';
  projectPhase.textContent = data.project_phase || 'Unknown';
  productUpdate.textContent = data.head_of_product_update || '';

  storyList.replaceChildren();
  currentStories.forEach((story) => {
    const li = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = story.title || 'Untitled story';
    li.append(title, document.createElement('br'));
    li.appendChild(document.createTextNode(
      `As a ${story.as_a || 'user'}, I want ${story.i_want || 'this capability'}, so that ${story.so_that || 'the outcome is improved'}.`
    ));
    li.append(document.createElement('br'));
    const priority = document.createElement('em');
    priority.textContent = story.priority || 'Medium';
    li.appendChild(priority);
    if (Array.isArray(story.acceptance_criteria) && story.acceptance_criteria.length) {
      const criteria = document.createElement('ul');
      story.acceptance_criteria.forEach((criterion) => {
        const criterionItem = document.createElement('li');
        criterionItem.textContent = criterion;
        criteria.appendChild(criterionItem);
      });
      li.appendChild(criteria);
    }
    storyList.appendChild(li);
  });

  umlOutput.textContent = data.uml?.content || 'No diagram generated.';

  testList.replaceChildren();
  (data.test_cases || data.test_scripts || []).forEach((test) => {
    const li = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = test.name || 'Test case';
    li.append(title, document.createElement('br'));
    li.appendChild(document.createTextNode(test.scenario || test.feature || ''));
    const steps = document.createElement('ul');
    (test.steps || []).forEach((step) => {
      const stepItem = document.createElement('li');
      stepItem.textContent = step;
      steps.appendChild(stepItem);
    });
    li.appendChild(steps);
    if (test.expected_result) {
      const expected = document.createElement('p');
      expected.textContent = `Expected: ${test.expected_result}`;
      li.appendChild(expected);
    }
    testList.appendChild(li);
  });

  brdOutput.textContent = data.brd || 'No BRD generated.';
  productDocsOutput.textContent = data.product_owner_documentation || 'No product owner documentation generated.';
  const safeItems = [
    ...(data.safe_artifacts?.features || []).map((item) => `Feature: ${item.title} — ${item.benefit_hypothesis || item.description || 'Benefit needs review'}`),
    ...(data.safe_artifacts?.pi_objectives || []).map((item) => `PI objective: ${item.objective} (business value: ${item.business_value || 'Not specified'}; committed: ${item.committed ? 'yes' : 'no'})`),
    ...(data.safe_artifacts?.wsjf_candidates || []).map((item) => `WSJF candidate: ${item.title} (business value: ${item.business_value || 'Not estimated'}; time criticality: ${item.time_criticality || 'Not estimated'}; risk reduction/opportunity: ${item.risk_reduction_or_opportunity_enablement || 'Not estimated'}; job size: ${item.job_size || 'Not estimated'})`)
  ];
  addTextListItems(safeArtifacts, safeItems, (item) => item);
  addTextListItems(technicalNotes, data.technical_notes, (note) => note);
  addTextListItems(
    roadmapList,
    data.roadmap?.milestones,
    (milestone) => `${milestone.name || 'Milestone'} - ${milestone.status || 'Status unknown'}; target: ${milestone.target || 'Not specified'}`
  );
  addTextListItems(
    riskList,
    data.risks,
    (risk) => `${risk.title || 'Risk'} — ${risk.description || ''} (Likelihood: ${risk.likelihood || 'Unknown'}, impact: ${risk.impact || 'Unknown'}). Mitigation: ${risk.mitigation || 'Not specified'}`
  );

  resultEl.classList.remove('hidden');
}

async function generateBacklog() {
  const text = inputText.value.trim();

  if (!text) {
    updateStatus('Please paste documentation or a transcript first.');
    return;
  }

  updateStatus('Planning the project pack with specialist agents...');

  try {
    const apiKey = apiKeyInput.value.trim();
    const { data } = await apiRequest('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        text,
        ...(currentProjectId ? { project_id: currentProjectId } : {}),
        ...(apiKey ? { apiKey } : {})
      })
    });
    renderResult(data);
    if (data.generation_mode === 'template') {
      updateStatus('Template output shown. Configure OPENAI_API_KEY to run the specialist agents.');
    } else {
      updateStatus(`Project pack generated by ${data.agents_run.join(', ')} agents.`);
    }
  } catch (error) {
    updateStatus(error.message || 'Something went wrong while generating the backlog.');
  }
}

async function askProductAgent() {
  const context = [currentProjectContext, inputText.value.trim(), latestGeneratedContext].filter(Boolean).join('\n\n');
  const question = questionInput.value.trim();
  if (!context) {
    updateStatus('Add project notes or generate a project pack before asking a question.');
    return;
  }
  if (!question) {
    updateStatus('Enter a project question first.');
    return;
  }

  updateStatus('Asking the product agent...');
  answerOutput.textContent = '';
  try {
    const apiKey = apiKeyInput.value.trim();
    const { data } = await apiRequest('/api/ask', {
      method: 'POST',
      body: JSON.stringify({
        context,
        question,
        ...(apiKey ? { apiKey } : {})
      })
    });
    answerOutput.textContent = [
      data.answer,
      data.known_facts?.length ? `Known facts: ${data.known_facts.join('; ')}` : '',
      data.unknowns?.length ? `Unknowns: ${data.unknowns.join('; ')}` : '',
      data.follow_up_actions?.length ? `Suggested follow-ups: ${data.follow_up_actions.join('; ')}` : ''
    ].filter(Boolean).join('\n\n');
    updateStatus('Project question answered.');
  } catch (error) {
    updateStatus(error.message || 'Something went wrong while answering the question.');
  }
}

async function appendUploadedDocuments() {
  const files = Array.from(documentUpload.files || []);
  if (!files.length) return;

  try {
    const documents = await Promise.all(files.map(async (file) => {
      if (file.size > 2 * 1024 * 1024) {
        throw new Error(`${file.name} exceeds the 2 MB per-file limit.`);
      }
      if (!/\.(txt|md|csv|json|log|vtt|srt)$/i.test(file.name)) {
        if (!/\.(pdf|docx|xlsx)$/i.test(file.name)) {
          throw new Error(`${file.name} is not a supported document or transcript format.`);
        }
        if (!currentProjectId) {
          throw new Error('Create or select a project before uploading PDF, Word, or Excel documents.');
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return { name: file.name, content_base64: btoa(binary), isBinary: true };
      }
      return { name: file.name, content: await file.text() };
    }));
    if (currentProjectId) {
      for (const document of documents) {
        await apiRequest(`/api/projects/${encodeURIComponent(currentProjectId)}/${document.isBinary ? 'upload' : 'documents'}`, {
          method: 'POST',
          body: JSON.stringify(document.isBinary
            ? { name: document.name, content_base64: document.content_base64 }
            : document)
        });
      }
      await selectProject(currentProjectId);
      await loadProjects(currentProjectId);
    } else {
      inputText.value = `${inputText.value}${documents.map(({ name, content }) => `\n\n--- ${name} ---\n${content}`).join('')}`.trim();
    }
    updateStatus(`Added ${files.length} document${files.length === 1 ? '' : 's'} to the project context.`);
    documentUpload.value = '';
  } catch (error) {
    updateStatus(error.message || 'Unable to read the selected documents.');
  }
}

async function draftMeetingAgenda() {
  const context = [currentProjectContext, inputText.value.trim(), latestGeneratedContext].filter(Boolean).join('\n\n');
  if (!context) {
    updateStatus('Add meeting notes, transcript, or project context before drafting an agenda.');
    return;
  }

  updateStatus('Drafting a meeting agenda...');
  try {
    const apiKey = apiKeyInput.value.trim();
    const { data } = await apiRequest('/api/meeting-agenda', {
      method: 'POST',
      body: JSON.stringify({
        context,
        trigger: agendaTrigger.value,
        ...(apiKey ? { apiKey } : {})
      })
    });
    agendaOutput.textContent = [
      `${data.title}\n${data.goal}`,
      `Topics:\n${data.topics.map((topic) => `- ${topic.topic} (${topic.duration_minutes} min): ${topic.prompt}`).join('\n')}`,
      `Decisions needed: ${data.decisions_needed.join('; ')}`,
      `Preparation: ${data.preparation.join('; ')}`
    ].join('\n\n');
    currentAgenda = data;
    updateStatus('Agenda drafted; review and schedule it in your meeting platform.');
  } catch (error) {
    updateStatus(error.message || 'Something went wrong while drafting the agenda.');
  }
}

async function scheduleReviewedAgenda(provider) {
  if (!currentAgenda) {
    updateStatus('Draft and review an agenda before scheduling a meeting.');
    return;
  }
  const start = new Date(document.getElementById('meetingStart').value);
  const end = new Date(document.getElementById('meetingEnd').value);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    updateStatus('Choose a meeting start and end time.');
    return;
  }
  const attendees = document.getElementById('meetingAttendees').value
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
  if (!window.confirm(`Create a ${provider === 'teams' ? 'Microsoft Teams' : 'Google Meet'} invitation and send it to ${attendees.length} attendee(s)?`)) return;

  const description = [
    currentAgenda.goal,
    ...currentAgenda.topics.map((topic) => `- ${topic.topic} (${topic.duration_minutes} min): ${topic.prompt}`),
    `Decisions needed: ${currentAgenda.decisions_needed.join('; ')}`,
    `Preparation: ${currentAgenda.preparation.join('; ')}`
  ].join('\n');
  try {
    const endpoint = provider === 'teams' ? '/api/meetings/teams' : '/api/meetings/google-calendar';
    const { data } = await apiRequest(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        title: currentAgenda.title,
        description,
        start: start.toISOString(),
        end: end.toISOString(),
        attendees
      })
    });
    if (data.html_link) {
      const link = document.createElement('a');
      link.href = data.html_link;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open calendar event';
      agendaOutput.append(document.createElement('br'), link);
    }
    if (data.meeting_url) agendaOutput.append(document.createTextNode(`\nJoin: ${data.meeting_url}`));
    updateStatus('Meeting scheduled and invitations sent.');
  } catch (error) {
    updateStatus(error.message);
  }
}

async function exportExcel() {
  if (!currentStories.length) {
    updateStatus('Generate a backlog before exporting to Excel.');
    return;
  }

  updateStatus('Preparing Excel export...');

  try {
    const { response } = await apiRequest('/api/export-excel', {
      method: 'POST',
      body: JSON.stringify({ stories: currentStories })
    });

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'product-owner-ai-backlog.xlsx';
    link.click();
    URL.revokeObjectURL(url);
    updateStatus('Excel export downloaded.');
  } catch (error) {
    updateStatus(error.message || 'Something went wrong during export.');
  }
}

async function processMeetingRecording() {
  const file = document.getElementById('recordingUpload').files[0];
  if (!file) return;
  updateStatus('Extracting audio and transcribing the meeting recording...');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the recording file.'));
    reader.readAsDataURL(file);
  });
  try {
    const { data: transcription } = await apiRequest('/api/meetings/transcribe-media', {
      method: 'POST', body: JSON.stringify({ file: { name: file.name, data } })
    });
    inputText.value = transcription.transcript;
    const { data: analysis } = await apiRequest('/api/requirements/classify', {
      method: 'POST', body: JSON.stringify({ transcript: transcription.transcript })
    });
    document.getElementById('recordingClassification').textContent = [
      `Recommended Jira type: ${analysis.classification.type}`,
      `Summary: ${analysis.summary || 'No clear summary detected.'}`,
      analysis.missing_information.length
        ? `Missing information:\n- ${analysis.missing_information.join('\n- ')}`
        : 'Information is sufficient for Jira creation.'
    ].join('\n\n');
    updateStatus('Recording transcribed and requirements classified. Review the missing-information report before creating Jira work.');
  } catch (error) {
    updateStatus(error.message);
  }
}

generateBtn.addEventListener('click', generateBacklog);
exportBtn.addEventListener('click', exportExcel);
askBtn.addEventListener('click', askProductAgent);
agendaBtn.addEventListener('click', draftMeetingAgenda);
document.getElementById('googleMeetingBtn').addEventListener('click', () => scheduleReviewedAgenda('google'));
document.getElementById('teamsMeetingBtn').addEventListener('click', () => scheduleReviewedAgenda('teams'));
documentUpload.addEventListener('change', appendUploadedDocuments);
document.getElementById('recordingUpload').addEventListener('change', processMeetingRecording);
inputText.addEventListener('input', () => {
  latestGeneratedContext = '';
});
document.getElementById('createProjectBtn').addEventListener('click', createProject);
document.getElementById('createWorkspaceBtn').addEventListener('click', createWorkspace);
document.getElementById('inviteBtn').addEventListener('click', createInvitation);
document.getElementById('acceptInviteBtn').addEventListener('click', acceptInvitation);
document.getElementById('teamPlanBtn').addEventListener('click', () => startCheckout('team'));
document.getElementById('businessPlanBtn').addEventListener('click', () => startCheckout('business'));
document.getElementById('paygPlanBtn').addEventListener('click', () => startCheckout('payg'));
document.getElementById('billingPortalBtn').addEventListener('click', openBillingPortal);
async function createJiraIssueFromUI() {
  try {
    if (!jiraSite.value) throw new Error('Connect Atlassian and select a Jira site first.');
    const { data } = await apiRequest('/api/integrations/jira/issues', {
      method: 'POST', body: JSON.stringify({
        site_id: jiraSite.value,
        project_key: document.getElementById('jiraProjectKey').value,
        issue_type: document.getElementById('jiraIssueType').value,
        summary: document.getElementById('jiraIssueSummary').value,
        description: document.getElementById('jiraIssueDescription').value
      })
    });
    updateStatus(`Created Jira ${data.key || 'issue'} in the connected organisation.`);
    await searchJiraIssues();
  } catch (error) { updateStatus(error.message); }
}

async function createConfluencePageFromUI() {
  try {
    if (!jiraSite.value) throw new Error('Connect Atlassian and select a site first.');
    const { data } = await apiRequest('/api/integrations/confluence/pages', {
      method: 'POST', body: JSON.stringify({
        site_id: jiraSite.value,
        space_id: document.getElementById('confluenceSpaceId').value,
        title: document.getElementById('confluencePageTitle').value,
        content: document.getElementById('jiraIssueDescription').value || '<p>No requirements details supplied.</p>'
      })
    });
    updateStatus(`Created Confluence page ${data.title || data.id || ''}.`);
  } catch (error) { updateStatus(error.message); }
}

document.getElementById('jiraCreateBtn').addEventListener('click', createJiraIssueFromUI);
document.getElementById('confluenceCreateBtn').addEventListener('click', createConfluencePageFromUI);
document.getElementById('jiraRefreshBtn').addEventListener('click', searchJiraIssues);
document.getElementById('confluenceSearchBtn').addEventListener('click', searchConfluence);
document.getElementById('driveSearchBtn').addEventListener('click', searchDriveFiles);
document.getElementById('zoomSearchBtn').addEventListener('click', searchZoomTranscripts);
document.getElementById('teamsTranscriptSearchBtn').addEventListener('click', searchTeamsTranscripts);
document.getElementById('standupBtn').addEventListener('click', draftStandup);
document.getElementById('loadSlackMembersBtn').addEventListener('click', loadSlackMembers);
document.getElementById('saveStandupScheduleBtn').addEventListener('click', saveStandupSchedule);
projectSelect.addEventListener('change', () => selectProject(projectSelect.value).catch((error) => updateStatus(error.message)));
workspaceSelect.addEventListener('change', async () => {
  try {
    await apiRequest('/api/workspaces/current', {
      method: 'PUT',
      body: JSON.stringify({ workspace_id: workspaceSelect.value })
    });
    currentProjectId = '';
    currentProjectContext = '';
    await loadAccount();
  } catch (error) {
    updateStatus(error.message);
  }
});
document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    await apiRequest('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    csrfToken = '';
    currentProjectId = '';
    currentProjectContext = '';
    signInActions.classList.remove('hidden');
    signedInActions.classList.add('hidden');
    projectPanel.classList.add('hidden');
    authStatus.textContent = 'Signed out.';
  } catch (error) {
    updateStatus(error.message);
  }
});
loadAccount();
document.getElementById('standupTimezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
