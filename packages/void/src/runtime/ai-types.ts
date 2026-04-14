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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionInputs {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
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
  choices: {
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }[];
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
