import { Logger, registerWorker } from 'iii-sdk';
import { z } from 'zod';

const iii = registerWorker(process.env.III_URL ?? 'ws://localhost:49134');
const logger = new Logger();

const inferenceRequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    }),
  ),
});

const inferenceResponseSchema = z.object({
  text: z.string(),
});

type InferenceRequest = z.infer<typeof inferenceRequestSchema>;

iii.registerFunction(
  'inference::get_response',
  async (payload: InferenceRequest) => {
    logger.info('inference::get_response called in TypeScript', payload);

    const result = await iii.trigger({
      function_id: 'inference::run_inference',
      payload,
    });

    const response = inferenceResponseSchema.safeParse(result);

    if (!response.success) {
      throw new Error('inference::run_inference returned an invalid response');
    }

    return response.data;
  },
  {
    request_format: z.toJSONSchema(inferenceRequestSchema),
    response_format: z.toJSONSchema(inferenceResponseSchema),
  },
);

iii.registerFunction(
  'http::run_inference_over_http',
  async (payload: { body: unknown }) => {
    const request = inferenceRequestSchema.safeParse(payload.body);

    if (!request.success) {
      return {
        status_code: 400,
        body: { error: 'Request body must contain messages with role and content strings.' },
        headers: { 'Content-Type': 'application/json' },
      };
    }

    const result = await iii.trigger({
      function_id: 'inference::get_response',
      payload: request.data,
    });

    const response = inferenceResponseSchema.safeParse(result);

    if (!response.success) {
      throw new Error('inference::get_response returned an invalid response');
    }

    logger.info('Running http inference...');
    return {
      status_code: 200,
      body: response.data,
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
