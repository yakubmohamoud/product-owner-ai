const crypto = require('node:crypto');
const { db, encrypt, createId } = require('./database');
const { getIntegration, refreshAccessToken } = require('./integrationService');
const { addJiraComment } = require('./integrationService');
const { logError } = require('./logger');

async function slackCall(tokens, method, values = {}) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(values),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Slack ${method} failed: ${result.error || response.statusText}.`);
  }
  return result;
}

async function listSlackMembers(organizationId) {
  const integration = getIntegration(organizationId, 'slack');
  const tokens = await refreshAccessToken(integration);
  const response = await fetch('https://slack.com/api/users.list?limit=200', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Slack users.list failed: ${result.error || response.statusText}.`);
  return (result.members || [])
    .filter((member) => !member.deleted && !member.is_bot && !member.is_app_user)
    .map((member) => ({
      id: member.id,
      name: member.profile?.real_name || member.real_name || member.name
    }));
}

function createSchedule(organizationId, userId, role, values, slackMembers) {
  if (!['owner', 'admin', 'company_admin', 'scrum_master'].includes(role)) {
    throw new Error('Only Company Admins and Scrum Masters can schedule stand-ups.');
  }
  const sendTime = values?.send_time;
  if (typeof sendTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime)) {
    throw new Error('Choose a valid daily send time in 24-hour HH:MM format.');
  }
  const timezone = values?.timezone;
  if (typeof timezone !== 'string' || timezone.length > 100) throw new Error('Choose a valid IANA timezone.');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    throw new Error('Choose a valid IANA timezone.');
  }
  if (!Array.isArray(values.slack_user_ids) || values.slack_user_ids.length < 1 || values.slack_user_ids.length > 200) {
    throw new Error('Select between 1 and 200 Slack team members.');
  }
  const available = new Set(slackMembers.map((member) => member.id));
  if (values.slack_user_ids.some((id) => !available.has(id))) {
    throw new Error('One or more selected Slack members are not active in the connected workspace.');
  }
  const issueKey = values.jira_issue_key || null;
  const siteId = values.jira_site_id || null;
  if (Boolean(issueKey) !== Boolean(siteId)) throw new Error('Choose both a Jira site and issue key, or leave both empty.');
  if (issueKey && !/^[A-Z][A-Z0-9_]{0,19}-[1-9]\d{0,8}$/.test(issueKey)) {
    throw new Error('Jira issue key is invalid.');
  }
  const id = createId();
  db.prepare(`
    INSERT INTO standup_schedules
      (id, organization_id, send_time, timezone, slack_user_ids, jira_site_id, jira_issue_key, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, organizationId, sendTime, timezone, JSON.stringify([...new Set(values.slack_user_ids)]),
    siteId, issueKey, userId, new Date().toISOString());
  return { id, send_time: sendTime, timezone, member_count: new Set(values.slack_user_ids).size };
}

function localScheduleTime(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    day: `${value.year}-${value.month}-${value.day}`,
    time: `${value.hour}:${value.minute}`
  };
}

async function sendDueStandups(now = new Date()) {
  const schedules = db.prepare(`
    SELECT * FROM standup_schedules WHERE enabled = 1 ORDER BY created_at
  `).all();
  for (const schedule of schedules) {
    const local = localScheduleTime(now, schedule.timezone);
    if (schedule.last_sent_day === local.day || schedule.send_time !== local.time) continue;
    const slack = getIntegration(schedule.organization_id, 'slack');
    const tokens = await refreshAccessToken(slack);
    const memberIds = JSON.parse(schedule.slack_user_ids);
    let allSent = true;
    for (const slackUserId of memberIds) {
      const prior = db.prepare(`
        SELECT 1 FROM standup_deliveries WHERE schedule_id = ? AND day_key = ? AND slack_user_id = ?
      `).get(schedule.id, local.day, slackUserId);
      if (prior) continue;
      try {
        const conversation = await slackCall(tokens, 'conversations.open', { users: slackUserId });
        const posted = await slackCall(tokens, 'chat.postMessage', {
          channel: conversation.channel.id,
          text: `Daily stand-up check-in for ${local.day}. Reply in this thread with:\nYesterday: …\nToday: …\nBlockers: …`
        });
        db.prepare(`
          INSERT INTO standup_deliveries
            (schedule_id, day_key, slack_user_id, channel_id, prompt_ts, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(schedule.id, local.day, slackUserId, conversation.channel.id, posted.ts, now.toISOString());
      } catch (error) {
        allSent = false;
        logError('slack_standup_delivery_failed', error, {
          schedule_id: schedule.id,
          organization_id: schedule.organization_id
        });
      }
    }
    if (allSent) {
      db.prepare('UPDATE standup_schedules SET last_sent_day = ? WHERE id = ?').run(local.day, schedule.id);
    }
  }
}

function verifySlackSignature(req) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  const timestamp = req.get('x-slack-request-timestamp');
  const signature = req.get('x-slack-signature');
  if (!secret || !req.rawBody || !/^\d+$/.test(timestamp || '') || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const base = `v0:${timestamp}:${req.rawBody.toString('utf8')}`;
  const expected = `v0=${crypto.createHmac('sha256', secret).update(base).digest('hex')}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

async function processSlackEvent(payload) {
  const event = payload.event;
  if (event?.type !== 'message' || event.subtype || event.bot_id || !event.thread_ts ||
    !event.user || !event.channel || !payload.event_id) return false;
  const delivery = db.prepare(`
    SELECT d.*, s.organization_id, s.jira_site_id, s.jira_issue_key
    FROM standup_deliveries d
    JOIN standup_schedules s ON s.id = d.schedule_id
    WHERE d.channel_id = ? AND d.prompt_ts = ? AND d.slack_user_id = ?
  `).get(event.channel, event.thread_ts, event.user);
  if (!delivery) return false;

  const inserted = db.prepare(`
    INSERT OR IGNORE INTO webhook_events (provider, event_id, created_at)
    VALUES ('slack', ?, ?)
  `).run(payload.event_id, new Date().toISOString());
  if (!inserted.changes) return true;

  const submissionId = createId();
  db.prepare(`
    INSERT INTO standup_submissions
      (id, schedule_id, day_key, slack_user_id, encrypted_content, external_message_ts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    submissionId,
    delivery.schedule_id,
    delivery.day_key,
    event.user,
    encrypt({ text: event.text || '' }),
    event.ts,
    new Date().toISOString()
  );

  const slack = getIntegration(delivery.organization_id, 'slack');
  const tokens = await refreshAccessToken(slack);
  let confirmation = 'Your stand-up reply was saved to the workspace.';
  if (delivery.jira_site_id && delivery.jira_issue_key) {
    try {
      await addJiraComment(
        delivery.organization_id,
        delivery.jira_site_id,
        delivery.jira_issue_key,
        `Daily stand-up update from Slack member ${event.user} (${delivery.day_key}):\n${event.text || ''}`
      );
      confirmation += ` Jira issue ${delivery.jira_issue_key} was updated.`;
    } catch (error) {
      confirmation += ` Jira posting failed and needs review: ${error.message}`;
    }
  } else {
    confirmation += ' No Jira issue was configured for automatic posting.';
  }
  await slackCall(tokens, 'chat.postMessage', {
    channel: event.channel,
    thread_ts: event.thread_ts,
    text: confirmation
  });
  return true;
}

function disableSchedule(organizationId, role, id) {
  if (!['owner', 'admin', 'company_admin', 'scrum_master'].includes(role)) {
    throw new Error('Only Company Admins and Scrum Masters can change stand-up schedules.');
  }
  const result = db.prepare(`
    UPDATE standup_schedules SET enabled = 0
    WHERE organization_id = ? AND id = ?
  `).run(organizationId, id);
  return result.changes > 0;
}

module.exports = {
  listSlackMembers,
  createSchedule,
  sendDueStandups,
  verifySlackSignature,
  processSlackEvent,
  disableSchedule
};
