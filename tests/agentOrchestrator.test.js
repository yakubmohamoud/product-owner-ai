const test = require('node:test');
const assert = require('node:assert/strict');
const {
  orchestrateArtifacts,
  wrapAgentClient,
  answerProductQuestion,
  generateMeetingAgenda
} = require('../backend/services/agentOrchestrator');
const { buildStandupDraft } = require('../backend/services/teamWorkflowService');

function createMockClient() {
  const calls = [];
  const outputs = {
    Product: {
      project_name: 'Example project',
      project_summary: 'A team is improving a user workflow.',
      project_phase: 'Discovery',
      safe_artifacts: { features: [], pi_objectives: [], wsjf_candidates: [] },
      user_stories: [{ title: 'Improve workflow' }],
      brd: '# Requirements',
      product_owner_documentation: '# Open questions'
    },
    Engineering: {
      uml: { type: 'mermaid', content: 'flowchart LR\n  A --> B' },
      technical_notes: ['Use the existing identity provider.']
    },
    QA: {
      test_cases: [{ name: 'Happy path', steps: ['Submit valid data'] }]
    },
    Delivery: {
      roadmap: { current_phase: 'Discovery', milestones: [] },
      risks: [],
      head_of_product_update: 'The project is in discovery.'
    },
    Agenda: {
      title: 'Resolve open story questions',
      goal: 'Agree on acceptance criteria.',
      attendees: ['Product owner', 'Engineering lead'],
      topics: [{ topic: 'Acceptance criteria', duration_minutes: 15, prompt: 'What is still unclear?' }],
      decisions_needed: ['Confirm acceptance criteria'],
      preparation: ['Review the story']
    }
  };

  return {
    calls,
    client: {
      chat: {
        completions: {
          create: async ({ messages }) => {
            const systemPrompt = messages[0].content;
            const agent = systemPrompt.includes('Agile delivery facilitator')
              ? 'Agenda'
              : systemPrompt.includes('Agile Delivery and Risk Agent')
              ? 'Delivery'
              : Object.keys(outputs).find((name) => systemPrompt.includes(`You are the ${name}`));
            calls.push(agent);
            return { choices: [{ message: { content: JSON.stringify(outputs[agent]) } }] };
          }
        }
      }
    }
  };
}

test('runs the product agent then specialist agents and combines their outputs', async () => {
  const { client, calls } = createMockClient();
  const result = await orchestrateArtifacts('The team discussed a user workflow.', client);

  assert.deepEqual(calls, ['Product', 'Engineering', 'QA', 'Delivery']);
  assert.equal(result.generation_mode, 'multi-agent');
  assert.equal(result.uml.content, 'flowchart LR\n  A --> B');
  assert.equal(result.test_scripts, result.test_cases);
  assert.equal(result.roadmap.current_phase, 'Discovery');
});

test('LLM client wrapper records provider model and exact token usage', async () => {
  const response = {
    model: 'gpt-test',
    usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
    choices: []
  };
  const events = [];
  const client = wrapAgentClient({
    chat: { completions: { create: async () => response } }
  }, async (usage) => events.push(usage));

  const actual = await client.chat.completions.create({ model: 'requested-model' });
  assert.equal(actual, response);
  assert.deepEqual(events, [{
    provider: 'openai',
    model: 'gpt-test',
    pricingModel: 'requested-model',
    inputTokens: 123,
    outputTokens: 45,
    totalTokens: 168
  }]);
});

test('uses clearly labelled template output when no provider is configured', async () => {
  const result = await orchestrateArtifacts('A project transcript with workflow requirements.', null);

  assert.equal(result.generation_mode, 'template');
  assert.deepEqual(result.agents_run, []);
  assert.match(result.brd, /Template output only/);
  assert.ok(result.test_cases.length > 0);
});

test('rejects empty input', async () => {
  await assert.rejects(orchestrateArtifacts('  ', null), /Text input is required/);
});

test('fails explicitly when an agent omits a required field', async () => {
  const { client } = createMockClient();
  client.chat.completions.create = async () => ({
    choices: [{ message: { content: JSON.stringify({ project_name: 'Incomplete' }) } }]
  });

  await assert.rejects(orchestrateArtifacts('Project context', client), /missing "project_summary"/);
});

test('answers product questions with known facts and unknowns', async () => {
  const { client } = createMockClient();
  client.chat.completions.create = async () => ({
    choices: [{
      message: {
        content: JSON.stringify({
          answer: 'The notes indicate discovery.',
          known_facts: ['The project is in discovery.'],
          unknowns: ['No Jira status was supplied.'],
          follow_up_actions: ['Check Jira for current status.']
        })
      }
    }]
  });

  const result = await answerProductQuestion('Discovery notes', 'What phase?', client);
  assert.match(result.answer, /discovery/);
  assert.equal(result.unknowns.length, 1);
});

test('drafts meeting agendas for supported Agile triggers', async () => {
  const { client } = createMockClient();
  const result = await generateMeetingAgenda('Story acceptance criteria remain unclear.', 'open_question', client);

  assert.equal(result.goal, 'Agree on acceptance criteria.');
  assert.equal(result.topics[0].duration_minutes, 15);
  await assert.rejects(
    generateMeetingAgenda('Some context', 'other', client),
    /Trigger must be one of/
  );
});

test('provides template answers and agendas without an AI provider', async () => {
  const answer = await answerProductQuestion('Payments are out of scope.', 'What is included?', null);
  assert.equal(answer.generation_mode, 'template');
  assert.match(answer.answer, /Payments are out of scope/);

  const agenda = await generateMeetingAgenda('Invoice export format is unresolved.', 'open_question', null);
  assert.equal(agenda.generation_mode, 'template');
  assert.equal(agenda.attendees.length, 3);
  assert.equal(agenda.topics.length, 1);
});

test('creates a reviewable stand-up summary and Jira comment draft', () => {
  const result = buildStandupDraft([{
    member: 'Alex',
    yesterday: 'Completed the API contract',
    today: 'Add validation',
    blockers: 'Waiting for test credentials'
  }]);

  assert.equal(result.requires_review, true);
  assert.match(result.jira_comment_draft, /Waiting for test credentials/);
  assert.throws(() => buildStandupDraft([]), /At least one team member update/);
});
