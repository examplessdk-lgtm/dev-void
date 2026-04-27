// Types for third-party AI providers via CF AI Gateway's OpenAI-compatible endpoint

export type ThirdPartyProvider =
  | 'openai'
  | 'anthropic'
  | 'google-ai-studio'
  | 'groq'
  | 'mistral'
  | 'grok'
  | 'deepseek'
  | 'openrouter'
  | 'perplexity'
  | 'cohere'
  | 'cerebras'
  | 'huggingface'
  | 'replicate'
  | 'baseten'
  | 'cartesia'
  | 'deepgram'
  | 'elevenlabs'
  | 'fal'
  | 'ideogram'
  | 'parallel';

export type ThirdPartyModel = `${ThirdPartyProvider}/${string}`;

export type ChatContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
    >;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatContent;
}

export interface ChatCompletionInputs {
  messages: Array<ChatMessage>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | Array<string>;
  stream?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<ChatCompletionChoice>;
  usage: ChatCompletionUsage;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

export type ImageGatewayEndpoint = 'images/generations' | 'images/edits';

export type ImageFileInput =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | {
      data: string;
      name?: string;
      type?: string;
    };

export interface ImageGenerationInputs {
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  response_format?: 'url' | 'b64_json';
  user?: string;
  [key: string]: unknown;
}

export interface ImageGenerationData {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface ImageGenerationResponse {
  created?: number;
  data: Array<ImageGenerationData>;
  usage?: unknown;
  [key: string]: unknown;
}

export interface ImageGenerationOptions {
  endpoint?: 'images/generations';
  [key: string]: unknown;
}

export interface ImageEditOptions {
  endpoint: 'images/edits';
  [key: string]: unknown;
}

export interface ImageEditInputs {
  prompt: string;
  image: ImageFileInput | Array<ImageFileInput>;
  mask?: ImageFileInput;
  n?: number;
  size?: string;
  response_format?: 'url' | 'b64_json';
  user?: string;
  [key: string]: unknown;
}

/** Maps provider prefix to expected env var name for the API key */
export const PROVIDER_KEY_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  'google-ai-studio': 'GOOGLE_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  grok: 'GROK_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  cohere: 'COHERE_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
  replicate: 'REPLICATE_API_KEY',
  baseten: 'BASETEN_API_KEY',
  cartesia: 'CARTESIA_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  fal: 'FAL_API_KEY',
  ideogram: 'IDEOGRAM_API_KEY',
  parallel: 'PARALLEL_API_KEY',
};
