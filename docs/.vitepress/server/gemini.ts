import { GoogleGenAI } from '@google/genai';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export interface ChatRequestBody {
  messages: ChatMessage[];
  model?: 'gemini-3.8-flash' | 'gemini-3.1-flash-lite' | 'gemini-4-argon';
  role?: string;
  systemInstruction?: string;
  useSearch?: boolean;
}

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface ChatResponseBody {
  reply: string;
  model: string;
  sources?: GroundingSource[];
  error?: string;
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const DEFAULT_SYSTEM_INSTRUCTION =
  `You are the official Void AI Assistant, an expert on Void (the full-stack framework for Cloudflare Workers powered by Vite) and modern Cloudflare Edge development.
You help developers with:
- Void routing: server routing (routes/*), pages routing (pages/* with React, Vue, Svelte, Solid), and edge handlers.
- Cloudflare bindings: D1 (SQLite), KV storage, Queues, Durable Objects, and Sandboxes.
- Real-time features: WebSockets, Server-Sent Events (SSE), and Live streams.
- Deployment: void deploy, configuration (void.deploy.config.ts), and Cloudflare Workers setup.
- Best practices: type safety, migrations with Drizzle, environment variables, and authentication.

When answering, be concise, accurate, and provide production-ready code examples when requested.
If Google Search grounding data is available, reference current web documentation and latest information accurately.`;

export async function handleGeminiChat(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
    return;
  }

  // Parse JSON request body
  let bodyStr = '';
  req.on('data', (chunk) => {
    bodyStr += chunk;
  });

  req.on('end', async () => {
    try {
      const body: ChatRequestBody = JSON.parse(bodyStr || '{}');
      const messages = body.messages || [];

      if (!Array.isArray(messages) || messages.length === 0) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'No messages provided in request body.' }));
        return;
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error:
              'GEMINI_API_KEY is not configured on the server. Please add your Gemini API key in the environment variables or Settings > Secrets panel.',
          })
        );
        return;
      }

      const ai = getGeminiClient();
      if (!ai) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Failed to initialize Gemini client.' }));
        return;
      }

      // Model selection:
      // gemini-4-argon for particularly complex tasks
      // gemini-3.8-flash for general tasks (and Search Grounding)
      // gemini-3.1-flash-lite for tasks that should happen fast
      let selectedModel = body.model || 'gemini-3.8-flash';
      const useSearch = Boolean(body.useSearch);

      // Search grounding requires gemini-3.8-flash or gemini-4-argon
      if (useSearch && selectedModel === 'gemini-3.1-flash-lite') {
        selectedModel = 'gemini-3.8-flash';
      }

      const systemInstruction = body.systemInstruction || body.role || DEFAULT_SYSTEM_INSTRUCTION;

      // Map conversation history
      const contents = messages.map((m) => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.text }],
      }));

      const config: Record<string, unknown> = {
        systemInstruction,
      };

      if (useSearch) {
        config.tools = [{ googleSearch: {} }];
      }

      const response = await ai.models.generateContent({
        model: selectedModel,
        contents,
        config,
      });

      const replyText = response.text || '';

      // Extract search grounding citations if available
      const rawChunks =
        response.candidates?.[0]?.groundingMetadata?.groundingChunks;
      const sources: GroundingSource[] = [];

      if (Array.isArray(rawChunks)) {
        for (const chunk of rawChunks) {
          if (chunk.web && chunk.web.uri) {
            sources.push({
              title: chunk.web.title || chunk.web.uri,
              uri: chunk.web.uri,
            });
          }
        }
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      const responsePayload: ChatResponseBody = {
        reply: replyText,
        model: selectedModel,
        sources: sources.length > 0 ? sources : undefined,
      };
      res.end(JSON.stringify(responsePayload));
    } catch (err: unknown) {
      console.error('[Gemini API] Error generating content:', err);
      let errorMessage =
        err instanceof Error ? err.message : 'Unknown server error occurred.';

      try {
        const parsed = JSON.parse(errorMessage);
        if (parsed.error && parsed.error.message) {
          errorMessage = parsed.error.message;
        }
      } catch {
        // Not a JSON string
      }

      let userFriendlyHint = '';
      if (errorMessage.includes('429') || errorMessage.includes('RESOURCE_EXHAUSTED')) {
        userFriendlyHint = ' Quota exceeded. Upgrading to a paid tier increases your quota. You can select a billing-enabled API key in Settings > Secrets.';
      } else if (errorMessage.includes('403') || errorMessage.includes('PERMISSION_DENIED') || errorMessage.includes('API_KEY_INVALID')) {
        userFriendlyHint = ' Please check or update your API key in Settings > Secrets.';
      }

      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: `${errorMessage}${userFriendlyHint}`,
        })
      );
    }
  });
}
