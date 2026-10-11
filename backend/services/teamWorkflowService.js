function buildStandupDraft(updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error('At least one team member update is required.');
  }

  const normalized = updates.map((update, index) => {
    if (!update || typeof update !== 'object' || Array.isArray(update)) {
      throw new Error(`Update ${index + 1} must be an object.`);
    }
    for (const field of ['member', 'yesterday', 'today', 'blockers']) {
      if (typeof update[field] !== 'string' || !update[field].trim()) {
        throw new Error(`Update ${index + 1} is missing "${field}".`);
      }
    }
    return {
      member: update.member.trim(),
      yesterday: update.yesterday.trim(),
      today: update.today.trim(),
      blockers: update.blockers.trim()
    };
  });

  return {
    summary: normalized.map((item) =>
      `${item.member}: yesterday — ${item.yesterday}; today — ${item.today}; blockers — ${item.blockers}`
    ),
    jira_comment_draft: normalized.map((item) =>
      `*${item.member}*\nYesterday: ${item.yesterday}\nToday: ${item.today}\nBlockers: ${item.blockers}`
    ).join('\n\n'),
    updates: normalized,
    requires_review: true
  };
}

module.exports = { buildStandupDraft };
