import { Logger, registerWorker } from 'iii-sdk';

const iii = registerWorker(process.env.III_URL ?? 'ws://localhost:49134');
const logger = new Logger();

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type InferenceRequest = {
  messages: ChatMessage[];
};

type InferenceResponse = {
  text: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function isInferenceRequest(value: unknown): value is InferenceRequest {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return false;
  }

  return value.messages.every((message) => {
    return (
      isRecord(message) &&
      (message.role === 'system' || message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string'
    );
  });
}

function isInferenceResponse(value: unknown): value is InferenceResponse {
  return isRecord(value) && typeof value.text === 'string';
}

iii.registerFunction(
  'inference::get_response',
  async (payload: InferenceRequest) => {
    logger.info('inference::get_response called in TypeScript', payload);

    const result = await iii.trigger({
      function_id: 'inference::run_inference',
      payload,
    });

    if (!isInferenceResponse(result)) {
      throw new Error('inference::run_inference returned an invalid response');
    }

    return result;
  },
);

iii.registerFunction(
  'http::run_inference_over_http',
  async (payload: { body: unknown }) => {
    if (!isInferenceRequest(payload.body)) {
      return {
        status_code: 400,
        body: { error: 'Request body must contain messages with role and content strings.' },
        headers: { 'Content-Type': 'application/json' },
      };
    }

    const result = await iii.trigger({
      function_id: 'inference::get_response',
      payload: payload.body,
    });

    if (!isInferenceResponse(result)) {
      throw new Error('inference::get_response returned an invalid response');
    }

    logger.info('Running http inference...');
    return {
      status_code: 200,
      body: result,
      headers: { 'Content-Type': 'application/json' },
    };
  },
);

iii.registerTrigger({
  type: 'http',
  function_id: 'http::run_inference_over_http',
  config: { api_path: '/v1/chat/completions', http_method: 'POST' },
});

logger.info('Caller worker started - listening for calls');
