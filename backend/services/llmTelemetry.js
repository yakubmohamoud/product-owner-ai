function wrapAgentClient(agentClient, onUsage) {
  if (!agentClient || typeof onUsage !== 'function') return agentClient;
  return {
    chat: {
      completions: {
        async create(params) {
          const response = await agentClient.chat.completions.create(params);
          const usage = response.usage;
          const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens;
          const outputTokens = usage?.completion_tokens ?? usage?.output_tokens;
          const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens;
          if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) ||
            !Number.isSafeInteger(totalTokens)) {
            throw new Error('LLM response omitted exact input/output token usage.');
          }
          await onUsage({
            provider: 'openai',
            model: response.model || params.model,
            pricingModel: params.model,
            inputTokens,
            outputTokens,
            totalTokens
          });
          return response;
        }
      }
    }
  };
}

module.exports = { wrapAgentClient };
