const crypto = require('node:crypto');
const { db, decrypt, encrypt } = require('./database');

function getIntegration(organizationId, provider, externalAccountId) {
  const integration = externalAccountId
    ? db.prepare(`
        SELECT * FROM integrations
        WHERE organization_id = ? AND provider = ? AND external_account_id = ?
      `).get(organizationId, provider, externalAccountId)
    : db.prepare(`
        SELECT * FROM integrations WHERE organization_id = ? AND provider = ? ORDER BY connected_at DESC LIMIT 1
      `).get(organizationId, provider);
  if (!integration) throw new Error(`${provider} is not connected to this workspace.`);
  return integration;
}

async function refreshAccessToken(integration) {
  const tokens = decrypt(integration.encrypted_tokens);
  if (!tokens.expires_at || tokens.expires_at > Date.now() + 60000) return tokens;
  if (!tokens.refresh_token) throw new Error(`${integration.provider} connection has no refresh token. Reconnect the integration.`);

  const provider = integration.provider;
  const isGoogle = provider === 'google_drive';
  const formEncoded = ['google_drive', 'slack', 'zoom', 'microsoft'].includes(provider);
  const tokenUrl = isGoogle
    ? 'https://oauth2.googleapis.com/token'
    : provider === 'slack'
      ? 'https://slack.com/api/oauth.v2.access'
      : provider === 'zoom'
        ? 'https://zoom.us/oauth/token'
        : provider === 'microsoft'
          ? 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
          : 'https://auth.atlassian.com/oauth/token';
  const clientId = isGoogle
    ? process.env.GOOGLE_CLIENT_ID
    : provider === 'slack' ? process.env.SLACK_CLIENT_ID
      : provider === 'zoom' ? process.env.ZOOM_CLIENT_ID
        : provider === 'microsoft' ? process.env.MICROSOFT_CLIENT_ID
          : process.env.ATLASSIAN_CLIENT_ID || process.env.JIRA_CLIENT_ID;
  const clientSecret = isGoogle
    ? process.env.GOOGLE_CLIENT_SECRET
    : provider === 'slack' ? process.env.SLACK_CLIENT_SECRET
      : provider === 'zoom' ? process.env.ZOOM_CLIENT_SECRET
        : provider === 'microsoft' ? process.env.MICROSOFT_CLIENT_SECRET
          : process.env.ATLASSIAN_CLIENT_SECRET || process.env.JIRA_CLIENT_SECRET;
  const headers = { Accept: 'application/json' };
  let body = JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token'
  });
  if (formEncoded) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams({
      client_id: clientId || '',
      client_secret: clientSecret || '',
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token'
    });
    if (provider === 'zoom') {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      body = new URLSearchParams({
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token'
      });
    }
    if (provider === 'microsoft') {
      body.set('scope', 'openid profile email offline_access User.Read Calendars.ReadWrite OnlineMeetings.Read OnlineMeetingTranscript.Read.All');
    }
    if (provider === 'slack') {
      body = new URLSearchParams({
        client_id: clientId || '',
        client_secret: clientSecret || '',
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token'
      });
    }
  } else {
    headers['Content-Type'] = 'application/json';
  }
  if (!clientId || !clientSecret) throw new Error(`${integration.provider} OAuth credentials are missing.`);

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15000)
  });
  const refreshed = await response.json();
  if (!response.ok || !refreshed.access_token || (provider === 'slack' && !refreshed.ok)) {
    throw new Error(`${integration.provider} token refresh failed (${response.status}). Reconnect the integration.`);
  }
  const nextTokens = {
    ...tokens,
    ...refreshed,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + (Number(refreshed.expires_in) || 3600) * 1000
  };
  db.prepare(`
    UPDATE integrations SET encrypted_tokens = ?, updated_at = ?
    WHERE organization_id = ? AND provider = ? AND external_account_id = ?
  `).run(encrypt(nextTokens), new Date().toISOString(), integration.organization_id,
    integration.provider, integration.external_account_id);
  return nextTokens;
}

async function providerFetch(url, accessToken, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${accessToken}`,
      ...options.headers
    },
    signal: options.signal || AbortSignal.timeout(20000)
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const detail = typeof payload === 'object' ? payload.errorMessages?.join('; ') || payload.message : '';
    throw new Error(`Connected provider request failed (${response.status})${detail ? `: ${detail}` : ''}.`);
  }
  return payload;
}

async function listAtlassianSites(organizationId) {
  const integration = getIntegration(organizationId, 'atlassian');
  const tokens = await refreshAccessToken(integration);
  const sites = await providerFetch('https://api.atlassian.com/oauth/token/accessible-resources', tokens.access_token);
  if (!Array.isArray(sites)) throw new Error('Atlassian returned an invalid accessible-site response.');
  const current = JSON.parse(integration.metadata || '{}');
  current.sites = sites.map((site) => ({
    id: site.id,
    name: site.name,
    url: site.url,
    scopes: site.scopes || []
  }));
  db.prepare(`
    UPDATE integrations SET metadata = ?, updated_at = ?
    WHERE organization_id = ? AND provider = ? AND external_account_id = ?
  `).run(JSON.stringify(current), new Date().toISOString(), organizationId, 'atlassian', integration.external_account_id);
  return current.sites;
}

function getAtlassianSite(integration, siteId) {
  const sites = JSON.parse(integration.metadata || '{}').sites || [];
  const site = sites.find((item) => item.id === siteId);
  if (!site) throw new Error('Choose a Jira site authorized for this workspace.');
  return site;
}

async function searchJiraIssues(organizationId, siteId, jql) {
  if (typeof jql !== 'string' || jql.length > 1000) throw new Error('Jira query must be a string under 1000 characters.');
  const integration = getIntegration(organizationId, 'atlassian');
  const site = getAtlassianSite(integration, siteId);
  const tokens = await refreshAccessToken(integration);
  const query = new URLSearchParams({
    jql: jql.trim() || 'ORDER BY updated DESC',
    maxResults: '50',
    fields: 'summary,status,assignee,priority,updated,issuetype'
  });
  const result = await providerFetch(
    `https://api.atlassian.com/ex/jira/${encodeURIComponent(site.id)}/rest/api/3/search/jql?${query}`,
    tokens.access_token
  );
  return { issues: result.issues || [], total: result.total || 0, site: { id: site.id, name: site.name } };
}

async function addJiraComment(organizationId, siteId, issueKey, text) {
  if (!/^[A-Z][A-Z0-9_]{0,19}-[1-9]\d{0,8}$/.test(issueKey)) throw new Error('Jira issue key is invalid.');
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 5000) {
    throw new Error('Comment must contain 1 to 5000 bytes.');
  }
  const integration = getIntegration(organizationId, 'atlassian');
  const site = getAtlassianSite(integration, siteId);
  const tokens = await refreshAccessToken(integration);
  const result = await providerFetch(
    `https://api.atlassian.com/ex/jira/${encodeURIComponent(site.id)}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
    tokens.access_token,
    {
      method: 'POST',
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: text.trim() }] }]
        }
      })
    }
  );
  return { id: result.id, issue_key: issueKey };
}

async function createJiraIssue(organizationId, siteId, issue) {
  const integration = getIntegration(organizationId, 'atlassian');
  const site = getAtlassianSite(integration, siteId);
  const projectKey = typeof issue.project_key === 'string' ? issue.project_key.trim().toUpperCase() : '';
  const summary = typeof issue.summary === 'string' ? issue.summary.trim() : '';
  const issueType = typeof issue.issue_type === 'string' ? issue.issue_type.trim() : 'Story';
  const allowedTypes = new Set(['Bug', 'Story', 'Task', 'Epic']);
  if (!/^[A-Z][A-Z0-9_]{0,9}$/.test(projectKey)) throw new Error('Provide a valid Jira project key.');
  if (!summary || summary.length > 255) throw new Error('Provide a Jira issue summary under 255 characters.');
  if (!allowedTypes.has(issueType)) throw new Error('Jira issue type must be Bug, Story, Task, or Epic.');
  const tokens = await refreshAccessToken(integration);
  return providerFetch(
    `https://api.atlassian.com/ex/jira/${encodeURIComponent(site.id)}/rest/api/3/issue`,
    tokens.access_token,
    {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          summary,
          issuetype: { name: issueType },
          description: {
            type: 'doc', version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: String(issue.description || '').slice(0, 32767) }] }]
          }
        }
      })
    }
  );
}

async function updateJiraIssue(organizationId, siteId, issueKey, changes) {
  if (!/^[A-Z][A-Z0-9_]{0,19}-[1-9]\d{0,8}$/.test(issueKey)) throw new Error('Jira issue key is invalid.');
  const integration = getIntegration(organizationId, 'atlassian');
  const site = getAtlassianSite(integration, siteId);
  const tokens = await refreshAccessToken(integration);
  const fields = {};
  if (typeof changes.summary === 'string') fields.summary = changes.summary.trim().slice(0, 255);
  if (typeof changes.description === 'string') {
    fields.description = {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: changes.description.slice(0, 32767) }] }]
    };
  }
  if (Object.keys(fields).length === 0) throw new Error('Provide a summary or description to update.');
  await providerFetch(
    `https://api.atlassian.com/ex/jira/${encodeURIComponent(site.id)}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    tokens.access_token,
    { method: 'PUT', body: JSON.stringify({ fields }) }
  );
  return { issue_key: issueKey, updated: true };
}

async function createConfluencePage(organizationId, siteId, page) {
  const integration = getIntegration(organizationId, 'atlassian');
  const site = getAtlassianSite(integration, siteId);
  const spaceId = typeof page.space_id === 'string' ? page.space_id.trim() : '';
  const title = typeof page.title === 'string' ? page.title.trim() : '';
  if (!/^\d+$/.test(spaceId)) throw new Error('Provide a numeric Confluence space ID.');
  if (!title || title.length > 255) throw new Error('Provide a Confluence page title under 255 characters.');
  const tokens = await refreshAccessToken(integration);
  return providerFetch(
    `https://api.atlassian.com/ex/confluence/${encodeURIComponent(site.id)}/wiki/api/v2/pages`,
    tokens.access_token,
    {
      method: 'POST',
      body: JSON.stringify({
        spaceId,
        status: 'current',
        title,
        parentId: page.parent_id || undefined,
        body: { representation: 'storage', value: String(page.content || '<p>Requirements generated by Product Owner AI</p>') }
      })
    }
  );
}

async function searchConfluence(organizationId, siteId, queryText) {
  if (typeof queryText !== 'string' || queryText.length > 300) {
    throw new Error('Confluence search query must be under 300 characters.');
  }
  const integration = getIntegration(organizationId, 'atlassian');
  const site = getAtlassianSite(integration, siteId);
  const tokens = await refreshAccessToken(integration);
  const cql = queryText.trim()
    ? `type=page AND text ~ "${queryText.replace(/["\\]/g, '')}"`
    : 'type=page';
  const params = new URLSearchParams({ cql, limit: '25', expand: 'space,version,body.storage' });
  return providerFetch(
    `https://api.atlassian.com/ex/confluence/${encodeURIComponent(site.id)}/wiki/rest/api/content/search?${params}`,
    tokens.access_token
  );
}

async function listDriveFiles(organizationId, queryText) {
  if (typeof queryText !== 'string' || queryText.length > 200) {
    throw new Error('Google Drive search text must be under 200 characters.');
  }
  const integration = getIntegration(organizationId, 'google_drive');
  const tokens = await refreshAccessToken(integration);
  const params = new URLSearchParams({
    pageSize: '50',
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
    q: `trashed = false${queryText.trim() ? ` and name contains '${queryText.trim().replace(/['\\]/g, '')}'` : ''}`
  });
  const result = await providerFetch(
    `https://www.googleapis.com/drive/v3/files?${params}`,
    tokens.access_token
  );
  return result.files || [];
}

async function getDriveDocumentText(organizationId, fileId) {
  if (typeof fileId !== 'string' || !/^[a-zA-Z0-9_-]{5,200}$/.test(fileId)) {
    throw new Error('Google Drive file ID is invalid.');
  }
  const integration = getIntegration(organizationId, 'google_drive');
  const tokens = await refreshAccessToken(integration);
  const metadata = await providerFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`,
    tokens.access_token
  );
  let content;
  if (metadata.mimeType === 'application/vnd.google-apps.document') {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`,
      { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(20000) }
    );
    if (!response.ok) throw new Error(`Google Drive document export failed (${response.status}).`);
    content = await response.text();
  } else if (['text/plain', 'text/markdown', 'text/csv', 'application/json'].includes(metadata.mimeType)) {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(20000) }
    );
    if (!response.ok) throw new Error(`Google Drive file download failed (${response.status}).`);
    content = await response.text();
  } else {
    throw new Error('Only Google Docs and text-based Drive files can be imported.');
  }
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('The selected Google Drive file exceeds the 2 MB import limit.');
  }
  return { id: metadata.id, name: metadata.name, mimeType: metadata.mimeType, content };
}

async function listZoomRecordings(organizationId, from, to) {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(from || '') || !datePattern.test(to || '') || new Date(to) < new Date(from)) {
    throw new Error('Provide a valid Zoom recording date range.');
  }
  const integration = getIntegration(organizationId, 'zoom');
  const tokens = await refreshAccessToken(integration);
  const params = new URLSearchParams({ from, to, page_size: '100', type: 'past' });
  const result = await providerFetch(`https://api.zoom.us/v2/users/me/recordings?${params}`, tokens.access_token);
  return (result.meetings || []).flatMap((meeting) =>
    (meeting.recording_files || [])
      .filter((file) => file.file_type === 'TRANSCRIPT' || file.file_extension === 'VTT')
      .map((file) => ({
        meeting_id: meeting.id,
        meeting_uuid: meeting.uuid,
        topic: meeting.topic,
        start_time: meeting.start_time,
        file_id: file.id,
        file_name: file.file_name,
        file_type: file.file_type
      }))
  );
}

async function getZoomTranscript(organizationId, meetingId, fileId) {
  const integration = getIntegration(organizationId, 'zoom');
  const tokens = await refreshAccessToken(integration);
  const result = await providerFetch(
    `https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}/recordings`,
    tokens.access_token
  );
  const file = result.recording_files?.find((item) => item.id === fileId &&
    (item.file_type === 'TRANSCRIPT' || item.file_extension === 'VTT'));
  if (!file?.download_url) throw new Error('The Zoom transcript recording could not be found.');
  const download = new URL(file.download_url);
  if (download.protocol !== 'https:' || !(download.hostname === 'zoom.us' || download.hostname.endsWith('.zoom.us'))) {
    throw new Error('Zoom returned an untrusted transcript download URL.');
  }
  const response = await fetch(download, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Zoom transcript download failed (${response.status}).`);
  const content = await response.text();
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('The Zoom transcript exceeds the 2 MB import limit.');
  }
  return { name: file.file_name || `zoom-${meetingId}.vtt`, content };
}

async function listTeamsTranscripts(organizationId, onlineMeetingId) {
  if (typeof onlineMeetingId !== 'string' || !onlineMeetingId.trim() || onlineMeetingId.length > 500) {
    throw new Error('Provide a valid Teams online meeting ID.');
  }
  const integration = getIntegration(organizationId, 'microsoft');
  const tokens = await refreshAccessToken(integration);
  const result = await providerFetch(
    `https://graph.microsoft.com/v1.0/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts`,
    tokens.access_token
  );
  return result.value || [];
}

async function getTeamsTranscript(organizationId, onlineMeetingId, transcriptId) {
  if (typeof transcriptId !== 'string' || !transcriptId.trim() || transcriptId.length > 500) {
    throw new Error('Provide a valid Teams transcript ID.');
  }
  const integration = getIntegration(organizationId, 'microsoft');
  const tokens = await refreshAccessToken(integration);
  const url = new URL(
    `https://graph.microsoft.com/v1.0/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`
  );
  url.searchParams.set('$format', 'text/vtt');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'text/vtt' },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Microsoft Teams transcript download failed (${response.status}).`);
  const content = await response.text();
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('The Teams transcript exceeds the 2 MB import limit.');
  }
  return { name: `teams-${transcriptId}.vtt`, content };
}

function validateMeetingRequest(meeting) {
  if (!meeting || typeof meeting !== 'object') throw new Error('Meeting details are required.');
  if (typeof meeting.title !== 'string' || !meeting.title.trim() || meeting.title.length > 200) {
    throw new Error('Meeting title must contain 1 to 200 characters.');
  }
  const start = new Date(meeting.start);
  const end = new Date(meeting.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) ||
    end <= start || end.getTime() - start.getTime() > 4 * 60 * 60 * 1000) {
    throw new Error('Choose a valid meeting time up to four hours long.');
  }
  if (!Array.isArray(meeting.attendees) || meeting.attendees.length > 50 ||
    meeting.attendees.some((email) => typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('Meeting attendees must be valid email addresses (up to 50).');
  }
  return { start, end, title: meeting.title.trim() };
}

async function createGoogleCalendarEvent(organizationId, meeting) {
  const validated = validateMeetingRequest(meeting);
  const integration = getIntegration(organizationId, 'google_drive');
  const tokens = await refreshAccessToken(integration);
  const event = await providerFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', tokens.access_token, {
    method: 'POST',
    body: JSON.stringify({
      summary: validated.title,
      description: typeof meeting.description === 'string' ? meeting.description.slice(0, 10000) : '',
      start: { dateTime: validated.start.toISOString() },
      end: { dateTime: validated.end.toISOString() },
      attendees: meeting.attendees.map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    })
  });
  return { id: event.id, html_link: event.htmlLink, meeting_url: event.hangoutLink || null };
}

async function createTeamsCalendarEvent(organizationId, meeting) {
  const validated = validateMeetingRequest(meeting);
  const integration = getIntegration(organizationId, 'microsoft');
  const tokens = await refreshAccessToken(integration);
  const event = await providerFetch('https://graph.microsoft.com/v1.0/me/events', tokens.access_token, {
    method: 'POST',
    body: JSON.stringify({
      subject: validated.title,
      body: {
        contentType: 'text',
        content: typeof meeting.description === 'string' ? meeting.description.slice(0, 10000) : ''
      },
      start: { dateTime: validated.start.toISOString(), timeZone: 'UTC' },
      end: { dateTime: validated.end.toISOString(), timeZone: 'UTC' },
      attendees: meeting.attendees.map((email) => ({
        emailAddress: { address: email },
        type: 'required'
      })),
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness'
    })
  });
  return {
    id: event.id,
    html_link: event.webLink,
    meeting_url: event.onlineMeeting?.joinUrl || null
  };
}

module.exports = {
  getIntegration,
  refreshAccessToken,
  listAtlassianSites,
  searchJiraIssues,
  addJiraComment,
  createJiraIssue,
  updateJiraIssue,
  createConfluencePage,
  searchConfluence,
  listDriveFiles,
  getDriveDocumentText,
  listZoomRecordings,
  getZoomTranscript,
  listTeamsTranscripts,
  getTeamsTranscript,
  createGoogleCalendarEvent,
  createTeamsCalendarEvent
};
