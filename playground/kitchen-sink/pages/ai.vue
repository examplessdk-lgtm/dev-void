<script setup lang="ts">
import { ref } from 'vue';
import type { Props } from './ai.server.ts';

const props = defineProps<Props>();

const selectedModel = ref(props.models[0].value);
const prompt = ref('');
const response = ref('');
const loading = ref(false);
const error = ref('');

async function submit() {
  if (!prompt.value.trim()) {
    return;
  }
  loading.value = true;
  response.value = '';
  error.value = '';

  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt.value, model: selectedModel.value }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      error.value = body?.error ?? `${res.status} ${res.statusText}`;
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      return;
    }

    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      // Parse SSE lines
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            // Workers AI format: { response: "..." }
            // OpenAI-compatible format: { choices: [{ delta: { content: "..." } }] }
            const token = parsed.response ?? parsed.choices?.[0]?.delta?.content ?? '';
            response.value += token;
          } catch {
            // skip unparseable chunks
          }
        }
      }
    }
  } catch (err) {
    error.value = String(err);
  } finally {
    loading.value = false;
  }
}
</script>
<template>
  <div>
    <h1>AI</h1>
    <p>AI inference via <code>void/ai</code>.</p>

    <h2>Model</h2>
    <select v-model="selectedModel" style="font-family: monospace; padding: 4px">
      <option v-for="m in models" :key="m.value" :value="m.value">
        {{ m.label }}
      </option>
    </select>

    <h2>Prompt</h2>
    <form @submit.prevent="submit">
      <div>
        <textarea
          v-model="prompt"
          placeholder="Ask something..."
          rows="3"
          style="width: 100%; font-family: monospace"
        ></textarea>
      </div>
      <button type="submit" :disabled="loading" style="margin-top: 5px">
        {{ loading ? 'Generating...' : 'Send' }}
      </button>
    </form>

    <div v-if="error" style="color: red; margin-top: 10px"><strong>Error:</strong> {{ error }}</div>

    <h2>Response</h2>
    <pre style="white-space: pre-wrap; background: #f5f5f5; padding: 10px; min-height: 60px">{{
      response || '(waiting for prompt...)'
    }}</pre>
  </div>
</template>
