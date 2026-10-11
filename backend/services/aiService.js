const OpenAI = require('openai');
const { wrapAgentClient } = require('./llmTelemetry');
const { logError } = require('./logger');

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function sanitizeJson(value, fallback) {
  if (!value || typeof value !== 'object') return fallback;
  return value;
}

function extractKeywords(text) {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((word) => word.length > 4)
    .filter((word) => !['that', 'with', 'from', 'into', 'this', 'have', 'will', 'about', 'there', 'their', 'does', 'need', 'team', 'user', 'users', 'product', 'system', 'feature', 'story'].includes(word));

  const unique = [...new Set(words)].slice(0, 4);
  return unique.length ? unique : ['workflow', 'dashboard', 'reporting', 'automation'];
}

function buildFallbackArtifact(text) {
  const keywords = extractKeywords(text);
  const subject = keywords[0] || 'workflow';
  const second = keywords[1] || 'team';
  const third = keywords[2] || 'operations';

  return {
    project_name: 'Generated backlog',
    user_stories: [
      {
        title: `Manage ${subject} efficiently`,
        as_a: 'team member',
        i_want: `to manage ${subject} without manual effort`,
        so_that: `I can improve ${second} outcomes and reduce delays`,
        acceptance_criteria: [
          `The system allows the user to create or update ${subject} entries`,
          `The system shows the latest ${subject} status clearly`,
          `The system validates required fields before saving`
        ],
        priority: 'High',
        labels: ['ai-generated', 'workflow']
      },
      {
        title: `Review ${third} status`,
        as_a: 'stakeholder',
        i_want: `to review ${third} progress across the team`,
        so_that: `I can make informed decisions based on real-time context`,
        acceptance_criteria: [
          `The dashboard displays current ${third} status`,
          `The system groups updates by team or owner`,
          `The user can export the summary to Excel or PDF`
        ],
        priority: 'Medium',
        labels: ['ai-generated', 'reporting']
      },
      {
        title: `Track ${subject} lifecycle`,
        as_a: 'operations lead',
        i_want: `to track the lifecycle of ${subject} from creation to completion`,
        so_that: `I can ensure accountability and faster delivery`,
        acceptance_criteria: [
          `The system captures the lifecycle status for each ${subject} item`,
          `The user can filter by stage, owner, or date`,
          `The system notifies the team when a stage is blocked`
        ],
        priority: 'High',
        labels: ['ai-generated', 'tracking']
      }
    ],
    uml: {
      type: 'mermaid',
      content: `
flowchart LR
    A[User] --> B[Create ${subject} item]
    B --> C[Review status]
    C --> D[Update progress]
    D --> E[Export report]
      `
    },
    test_scripts: [
      {
        name: `Create ${subject} item`,
        feature: 'Workflow management',
        scenario: `User creates a new ${subject} item`,
        steps: [
          'Given the user opens the workflow form',
          'When they enter a valid ${subject} title and required details',
          'And they click Save',
          'Then the item is created and visible in the dashboard'
        ]
      },
      {
        name: `Review ${third} status`,
        feature: 'Reporting',
        scenario: `User reviews the latest ${third} state`,
        steps: [
          'Given the user is on the reporting view',
          'When they open the status dashboard',
          'Then the latest data is displayed for each owner and stage'
        ]
      }
    ]
  };
}

async function generateArtifacts(text, agentClient = client, onUsage) {
  if (!text || !text.trim()) {
    throw new Error('Text input is required.');
  }

  if (!agentClient) {
    return buildFallbackArtifact(text);
  }
  if (typeof onUsage !== 'function') {
    throw new Error('LLM telemetry callback is required for every generation.');
  }

  try {
    const response = await wrapAgentClient(agentClient, onUsage).chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a senior product owner and software analyst. Convert input docs or meeting transcripts into a structured JSON payload.
Return only valid JSON with this shape:
{
  "project_name": "string",
  "user_stories": [{
    "title": "string",
    "as_a": "string",
    "i_want": "string",
    "so_that": "string",
    "acceptance_criteria": ["string"],
    "priority": "Low|Medium|High",
    "labels": ["string"]
  }],
  "uml": {
    "type": "mermaid",
    "content": "string"
  },
  "test_scripts": [{
    "name": "string",
    "feature": "string",
    "scenario": "string",
    "steps": ["string"]
  }]
}`
        },
        {
          role: 'user',
          content: text
        }
      ]
    });

    const content = response.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content || '{}');

    return sanitizeJson(parsed, buildFallbackArtifact(text));
  } catch (error) {
    logError('legacy_llm_generation_failed', error);
    throw error;
  }
}

module.exports = {
  generateArtifacts,
  buildFallbackArtifact
};
