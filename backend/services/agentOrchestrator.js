const OpenAI = require('openai');
const { buildFallbackArtifact } = require('./aiService');
const { wrapAgentClient } = require('./llmTelemetry');

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const AGENT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const configuredMaxTokens = Number(process.env.MANAGED_MAX_OUTPUT_TOKENS || 4096);
if (!Number.isSafeInteger(configuredMaxTokens) || configuredMaxTokens <= 0) {
  throw new Error('MANAGED_MAX_OUTPUT_TOKENS must be a positive integer.');
}
const MAX_OUTPUT_TOKENS = Math.min(configuredMaxTokens, 16384);

function createRequestAgentClient(apiKey, onUsage) {
  let agentClient = client;
  if (apiKey !== undefined && apiKey !== null && apiKey !== '') {
    if (typeof apiKey !== 'string' || apiKey.length > 512 || !apiKey.trim()) {
      throw new Error('A provided API key must be a non-empty string under 512 characters.');
    }
    agentClient = new OpenAI({ apiKey: apiKey.trim() });
  }
  return wrapAgentClient(agentClient, onUsage);
}

function requireFields(value, fields, agentName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${agentName} agent returned an invalid response.`);
  }

  for (const field of fields) {
    if (!(field in value)) {
      throw new Error(`${agentName} agent response is missing "${field}".`);
    }
  }
}

function requireArray(value, field, agentName) {
  if (!Array.isArray(value)) {
    throw new Error(`${agentName} agent response field "${field}" must be an array.`);
  }
}

function requireStrings(value, fields, agentName) {
  for (const field of fields) {
    if (typeof value[field] !== 'string') {
      throw new Error(`${agentName} agent response field "${field}" must be a string.`);
    }
  }
}

async function runAgent(agentClient, name, instructions, context) {
  const response = await agentClient.chat.completions.create({
    model: AGENT_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `${instructions}\nReturn only valid JSON. Do not invent decisions, dates, owners, or commitments that are not supported by the context. Mark unknowns as open questions.`
      },
      {
        role: 'user',
        content: context
      }
    ]
  });

  const content = response.choices?.[0]?.message?.content;
  let result;

  try {
    result = JSON.parse(content || '');
  } catch (error) {
    throw new Error(`${name} agent returned invalid JSON.`, { cause: error });
  }

  return result;
}

function buildTemplateProjectPack(text) {
  const fallback = buildFallbackArtifact(text);

  return {
    ...fallback,
    project_summary: 'Template output based on the supplied text. Configure an OpenAI API key for context-aware agent analysis.',
    project_phase: 'Needs review',
    safe_artifacts: {
      features: [],
      pi_objectives: [],
      wsjf_candidates: []
    },
    brd: 'Template output only. Configure an OpenAI API key to generate a business requirements document from the supplied context.',
    product_owner_documentation: 'Template output only. Product decisions, stakeholders, and open questions require AI analysis.',
    technical_notes: ['Template output only. Technical constraints and architecture require AI analysis.'],
    test_cases: fallback.test_scripts.map((test) => ({
      ...test,
      expected_result: 'The expected result should be confirmed against the project requirements.'
    })),
    roadmap: {
      current_phase: 'Needs review',
      milestones: []
    },
    risks: [],
    head_of_product_update: 'Template output only. Configure an OpenAI API key to generate a project status update.',
    generation_mode: 'template',
    agents_run: []
  };
}

async function orchestrateArtifacts(text, agentClient = client) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Text input is required.');
  }

  if (!agentClient) {
    return buildTemplateProjectPack(text);
  }

  const product = await runAgent(
    agentClient,
    'Product',
    `You are the Product Planning Agent for a consultancy Agile team. Analyze the supplied meeting transcript or project documentation. Produce:
{
  "project_name": "string",
  "project_summary": "string",
  "project_phase": "string",
  "safe_artifacts": {
    "features": [{
      "title": "string",
      "description": "string",
      "benefit_hypothesis": "string",
      "acceptance_criteria": ["string"],
      "enabler": true
    }],
    "pi_objectives": [{
      "objective": "string",
      "business_value": "string",
      "committed": true
    }],
    "wsjf_candidates": [{
      "title": "string",
      "business_value": "string",
      "time_criticality": "string",
      "risk_reduction_or_opportunity_enablement": "string",
      "job_size": "string"
    }]
  },
  "user_stories": [{
    "title": "string",
    "as_a": "string",
    "i_want": "string",
    "so_that": "string",
    "acceptance_criteria": ["string"],
    "priority": "Low|Medium|High",
    "labels": ["string"]
  }],
  "brd": "Markdown business requirements document",
  "product_owner_documentation": "Markdown including decisions, assumptions, and unresolved questions"
}
Align outputs to SAFe where appropriate. Treat PI objectives, features, and WSJF values as proposals; do not invent commitments or numerical WSJF scores. Distinguish explicit facts from assumptions. Do not claim live project status that the source does not establish.`,
    text
  );
  requireFields(product, [
    'project_name',
    'project_summary',
    'project_phase',
    'safe_artifacts',
    'user_stories',
    'brd',
    'product_owner_documentation'
  ], 'Product');
  requireStrings(product, [
    'project_name',
    'project_summary',
    'project_phase',
    'brd',
    'product_owner_documentation'
  ], 'Product');
  requireFields(product.safe_artifacts, ['features', 'pi_objectives', 'wsjf_candidates'], 'Product SAFe artifacts');
  requireArray(product.safe_artifacts.features, 'features', 'Product SAFe artifacts');
  requireArray(product.safe_artifacts.pi_objectives, 'pi_objectives', 'Product SAFe artifacts');
  requireArray(product.safe_artifacts.wsjf_candidates, 'wsjf_candidates', 'Product SAFe artifacts');
  requireArray(product.user_stories, 'user_stories', 'Product');

  const context = JSON.stringify({
    source_summary: product.project_summary,
    phase: product.project_phase,
    stories: product.user_stories,
    product_documentation: product.product_owner_documentation
  });

  const [engineering, qa, delivery] = await Promise.all([
    runAgent(
      agentClient,
      'Engineering',
      `You are the Engineering Agent. Based only on the project context, produce:
{
  "uml": {"type": "mermaid", "content": "valid Mermaid diagram source code"},
  "technical_notes": ["string"]
}
The diagram must be Mermaid source code, not an image. Prefer a Mermaid classDiagram or sequenceDiagram to represent the system structure or interactions.`,
      context
    ),
    runAgent(
      agentClient,
      'QA',
      `You are the QA Agent. Create actionable, traceable test cases from the supplied stories and requirements:
{
  "test_cases": [{
    "name": "string",
    "feature": "string",
    "scenario": "string",
    "steps": ["string"],
    "expected_result": "string"
  }]
}
Include positive, negative, and boundary cases where the requirements support them. Do not invent unprovided business rules.`,
      context
    ),
    runAgent(
      agentClient,
      'Delivery',
      `You are the Agile Delivery and Risk Agent. Produce a cautious status update and roadmap from the supplied context:
{
  "roadmap": {
    "current_phase": "string",
    "milestones": [{
      "name": "string",
      "target": "string",
      "status": "string",
      "dependencies": ["string"]
    }]
  },
  "risks": [{
    "title": "string",
    "description": "string",
    "likelihood": "Low|Medium|High|Unknown",
    "impact": "Low|Medium|High|Unknown",
    "mitigation": "string"
  }],
  "head_of_product_update": "string"
}
Do not infer actual Jira status or dates from a transcript. Clearly label unknown status and targets.`,
      context
    )
  ]);

  requireFields(engineering, ['uml', 'technical_notes'], 'Engineering');
  requireFields(qa, ['test_cases'], 'QA');
  requireFields(delivery, ['roadmap', 'risks', 'head_of_product_update'], 'Delivery');
  if (!engineering.uml || typeof engineering.uml.content !== 'string') {
    throw new Error('Engineering agent response must include Mermaid diagram source code.');
  }
  requireArray(engineering.technical_notes, 'technical_notes', 'Engineering');
  requireArray(qa.test_cases, 'test_cases', 'QA');
  requireFields(delivery.roadmap, ['current_phase', 'milestones'], 'Delivery roadmap');
  requireStrings(delivery.roadmap, ['current_phase'], 'Delivery roadmap');
  requireArray(delivery.roadmap.milestones, 'milestones', 'Delivery');
  requireArray(delivery.risks, 'risks', 'Delivery');
  requireStrings(delivery, ['head_of_product_update'], 'Delivery');

  return {
    ...product,
    ...engineering,
    ...qa,
    ...delivery,
    test_scripts: qa.test_cases,
    generation_mode: 'multi-agent',
    agents_run: ['Product', 'Engineering', 'QA', 'Delivery']
  };
}

async function answerProductQuestion(context, question, agentClient = client) {
  if (typeof question !== 'string' || !question.trim()) {
    throw new Error('A question is required.');
  }
  if (!agentClient) {
    throw new Error('Configure OPENAI_API_KEY or provide a request-scoped API key to ask project questions.');
  }

  const answer = await runAgent(
    agentClient,
    'Product',
    `You are a product delivery assistant for an Agile consultancy team. Answer the user's question using only the supplied project context. Be explicit about the project phase and current work only when supported by that context. Identify unknowns rather than inferring live Jira or team status. Return JSON: {"answer":"string","known_facts":["string"],"unknowns":["string"],"follow_up_actions":["string"]}`,
    JSON.stringify({ project_context: context, question })
  );
  requireFields(answer, ['answer', 'known_facts', 'unknowns', 'follow_up_actions'], 'Product');
  requireStrings(answer, ['answer'], 'Product');
  requireArray(answer.known_facts, 'known_facts', 'Product');
  requireArray(answer.unknowns, 'unknowns', 'Product');
  requireArray(answer.follow_up_actions, 'follow_up_actions', 'Product');
  return answer;
}

async function generateMeetingAgenda(context, trigger, agentClient = client) {
  if (typeof context !== 'string' || !context.trim()) {
    throw new Error('Meeting context is required.');
  }
  const validTriggers = ['open_question', 'inconclusive_meeting', 'stale_story'];
  if (!validTriggers.includes(trigger)) {
    throw new Error(`Trigger must be one of: ${validTriggers.join(', ')}.`);
  }
  if (!agentClient) {
    throw new Error('Configure OPENAI_API_KEY or provide a request-scoped API key to generate an agenda.');
  }

  const agenda = await runAgent(
    agentClient,
    'Delivery',
    `You are an Agile delivery facilitator. Prepare a short, outcome-oriented meeting agenda from the supplied context and trigger. Return JSON: {"title":"string","goal":"string","attendees":["roles or people explicitly identified; otherwise use relevant roles"],"topics":[{"topic":"string","duration_minutes":number,"prompt":"string"}],"decisions_needed":["string"],"preparation":["string"]}. Do not schedule a meeting or invent calendar availability.`,
    JSON.stringify({ trigger, context })
  );
  requireFields(agenda, ['title', 'goal', 'attendees', 'topics', 'decisions_needed', 'preparation'], 'Delivery agenda');
  requireStrings(agenda, ['title', 'goal'], 'Delivery agenda');
  for (const field of ['attendees', 'topics', 'decisions_needed', 'preparation']) {
    requireArray(agenda[field], field, 'Delivery agenda');
  }
  return agenda;
}

module.exports = {
  orchestrateArtifacts,
  buildTemplateProjectPack,
  createRequestAgentClient,
  wrapAgentClient,
  answerProductQuestion,
  generateMeetingAgenda
};
