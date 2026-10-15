<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue';

interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: string;
  model?: string;
  sources?: Array<{ title: string; uri: string }>;
  error?: boolean;
}

const isOpen = ref(false);
const inputMessage = ref('');
const isLoading = ref(false);
const errorMessage = ref('');
const messagesContainer = ref<HTMLDivElement | null>(null);

const selectedModel = ref<'gemini-3.8-flash' | 'gemini-3.1-flash-lite' | 'gemini-4-argon'>('gemini-3.8-flash');
const useSearchGrounding = ref(true);

const roles = [
  {
    id: 'void-expert',
    name: 'Void Framework Expert',
    description: 'Specialist in Void routing, Vite integration, Cloudflare bindings, and deployment',
    systemInstruction:
      'You are the official Void AI Assistant, an expert on Void (the full-stack framework for Cloudflare Workers powered by Vite). You assist developers with routing, Cloudflare bindings (D1, KV, Queues, Sandboxes), ISR, authentication, and deployment. Provide accurate, idiomatic TypeScript examples adhering to Void standards.',
  },
  {
    id: 'edge-specialist',
    name: 'Cloudflare Edge Specialist',
    description: 'Expert in Cloudflare Workers, Durable Objects, KV, and edge execution',
    systemInstruction:
      'You are a Cloudflare Workers and Edge infrastructure expert. You guide developers on Workers limits, durable objects, subrequests, edge caching, wrangler configurations, and production edge deployment architectures.',
  },
  {
    id: 'code-architect',
    name: 'Full-Stack Code Architect',
    description: 'Senior engineer for deep TypeScript reasoning, refactoring, and code review',
    systemInstruction:
      'You are a senior full-stack TypeScript architect specializing in Vite, React, Vue, Svelte, Solid, and modern web application patterns. You provide rigorous technical analysis, architecture recommendations, and bug fixes.',
  },
];

const selectedRoleId = ref('void-expert');
const selectedRole = computed(() => roles.find((r) => r.id === selectedRoleId.value) || roles[0]);

const messages = ref<ChatMessage[]>([
  {
    id: 'welcome',
    role: 'model',
    text: "Hello! I'm your **Void AI Assistant** powered by Gemini. Ask me about Void routing, Cloudflare Workers bindings (D1, KV, Queues), deployment, or use real-time **Google Search Grounding** for web-connected information.",
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    model: 'gemini-3.8-flash',
  },
]);

const suggestedQuestions = [
  'How do I configure D1 database and Drizzle in Void?',
  'Explain how ISR revalidation works on Cloudflare',
  'What are the latest Cloudflare Workers features in 2026?',
  'Show me an example of WebSocket live streaming in Void',
];

function toggleOpen() {
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    nextTick(() => scrollToBottom());
  }
}

function scrollToBottom() {
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
}

watch(messages, () => {
  nextTick(() => scrollToBottom());
}, { deep: true });

function formatMarkdown(text: string): string {
  // Simple markdown renderer for code blocks, bold, lists, and inline code
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Triple backticks code blocks
  html = html.replace(/```([a-z0-9]*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre class="chat-code-block"><code>${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Bullet points
  html = html.replace(/^\s*[-*]\s+(.+)$/gm, '<li class="chat-li">$1</li>');

  // Wrap consecutive li items
  html = html.replace(/(<li class="chat-li">[\s\S]*?<\/li>)/g, '<ul class="chat-ul">$1</ul>');

  // Line breaks
  html = html.replace(/\n\n/g, '<br><br>');

  return html;
}

async function sendMessage(textToSend?: string) {
  const text = (textToSend ?? inputMessage.value).trim();
  if (!text || isLoading.value) return;

  errorMessage.value = '';
  inputMessage.value = '';

  const userMsg: ChatMessage = {
    id: `user-${Date.now()}`,
    role: 'user',
    text,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };

  messages.value.push(userMsg);
  isLoading.value = true;

  // Prepare conversation history payload
  const historyPayload = messages.value
    .filter((m) => !m.error)
    .map((m) => ({
      role: m.role,
      text: m.text,
    }));

  try {
    const res = await fetch('/api/gemini/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: historyPayload,
        model: selectedModel.value,
        role: selectedRole.value.name,
        systemInstruction: selectedRole.value.systemInstruction,
        useSearch: useSearchGrounding.value,
      }),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || `Server returned status ${res.status}`);
    }

    const modelMsg: ChatMessage = {
      id: `model-${Date.now()}`,
      role: 'model',
      text: data.reply || 'No response received from the model.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      model: data.model || selectedModel.value,
      sources: data.sources || undefined,
    };

    messages.value.push(modelMsg);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to communicate with Gemini API';
    errorMessage.value = msg;
    messages.value.push({
      id: `err-${Date.now()}`,
      role: 'model',
      text: `⚠️ **Error:** ${msg}\n\n*Make sure GEMINI_API_KEY is configured in Settings > Secrets or the server environment.*`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      error: true,
    });
  } finally {
    isLoading.value = false;
    nextTick(() => scrollToBottom());
  }
}

function clearChat() {
  messages.value = [
    {
      id: 'welcome-reset',
      role: 'model',
      text: "Conversation cleared. What would you like to build or discuss with **Void** and **Cloudflare Workers**?",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      model: selectedModel.value,
    },
  ];
  errorMessage.value = '';
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}
</script>

<template>
  <div class="void-gemini-chatbot-root">
    <!-- Floating Trigger Button -->
    <button
      type="button"
      class="chat-trigger-btn"
      :class="{ 'is-open': isOpen }"
      aria-label="Toggle Void AI Assistant"
      @click="toggleOpen"
    >
      <div class="chat-trigger-icon">
        <svg v-if="!isOpen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-6 h-6">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-6 h-6">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
      <span v-if="!isOpen" class="chat-trigger-label">Void AI</span>
      <span class="chat-trigger-badge">Gemini</span>
    </button>

    <!-- Main Chat Window Panel -->
    <transition name="chat-fade">
      <div v-if="isOpen" class="chat-window-panel">
        <!-- Header -->
        <div class="chat-header">
          <div class="chat-header-title-row">
            <div class="chat-title-group">
              <div class="chat-avatar">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-5 h-5 text-white">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div>
                <h3 class="chat-header-title">Void AI Assistant</h3>
                <p class="chat-header-subtitle">Full-stack & Edge Copilot</p>
              </div>
            </div>
            <div class="chat-header-actions">
              <button
                type="button"
                class="header-icon-btn"
                title="Clear conversation"
                @click="clearChat"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
              <button
                type="button"
                class="header-icon-btn"
                title="Close chat"
                @click="isOpen = false"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Controls Bar: Model & Role & Search Grounding -->
          <div class="chat-controls-bar">
            <!-- Model Picker -->
            <div class="control-item">
              <label class="control-label" for="model-select">Model:</label>
              <select id="model-select" v-model="selectedModel" class="control-select">
                <option value="gemini-3.8-flash">gemini-3.8-flash (General & Search)</option>
                <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (Fast)</option>
                <option value="gemini-4-argon">gemini-4-argon (Complex Tasks)</option>
              </select>
            </div>

            <!-- Role / Persona Picker -->
            <div class="control-item">
              <label class="control-label" for="role-select">Role:</label>
              <select id="role-select" v-model="selectedRoleId" class="control-select">
                <option v-for="r in roles" :key="r.id" :value="r.id">
                  {{ r.name }}
                </option>
              </select>
            </div>

            <!-- Search Grounding Toggle -->
            <div class="search-grounding-toggle">
              <label class="search-toggle-label" title="Ground responses with real-time Google Search data">
                <input
                  type="checkbox"
                  v-model="useSearchGrounding"
                  class="search-checkbox"
                />
                <span class="search-icon">🔍</span>
                <span class="search-text">Google Search</span>
              </label>
            </div>
          </div>
        </div>

        <!-- Scrollable Messages Container -->
        <div ref="messagesContainer" class="chat-messages-container">
          <div
            v-for="msg in messages"
            :key="msg.id"
            :class="['chat-bubble-wrapper', msg.role === 'user' ? 'is-user' : 'is-model']"
          >
            <div :class="['chat-bubble', msg.role === 'user' ? 'user-bubble' : 'model-bubble', { 'has-error': msg.error }]">
              <!-- Header info for model -->
              <div v-if="msg.role === 'model'" class="model-meta-header">
                <span class="model-badge">{{ msg.model || 'Gemini' }}</span>
                <span v-if="msg.sources && msg.sources.length" class="grounded-tag">
                  🌐 Google Search Grounded
                </span>
                <span class="msg-time">{{ msg.timestamp }}</span>
              </div>

              <!-- Message Text -->
              <div class="msg-content" v-html="formatMarkdown(msg.text)"></div>

              <!-- Search Grounding Sources Cards -->
              <div v-if="msg.sources && msg.sources.length" class="grounding-sources-section">
                <div class="grounding-sources-title">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3.5 h-3.5 inline mr-1">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
                  </svg>
                  Sources cited from Google Search:
                </div>
                <div class="grounding-sources-list">
                  <a
                    v-for="(src, idx) in msg.sources"
                    :key="idx"
                    :href="src.uri"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="grounding-source-chip"
                    :title="src.uri"
                  >
                    <span class="source-index">{{ idx + 1 }}</span>
                    <span class="source-title">{{ src.title }}</span>
                  </a>
                </div>
              </div>

              <div v-if="msg.role === 'user'" class="user-meta-footer">
                <span class="msg-time">{{ msg.timestamp }}</span>
              </div>
            </div>
          </div>

          <!-- Loading Indicator -->
          <div v-if="isLoading" class="chat-bubble-wrapper is-model">
            <div class="chat-bubble model-bubble loading-bubble">
              <div class="thinking-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
              <span class="thinking-label">
                {{ useSearchGrounding ? 'Searching Google & reasoning...' : 'Thinking...' }}
              </span>
            </div>
          </div>
        </div>

        <!-- Suggested Prompt Chips (when few messages) -->
        <div v-if="messages.length <= 2" class="chat-suggestions-bar">
          <span class="suggestions-hint">Try asking:</span>
          <div class="suggestions-scroll">
            <button
              v-for="(q, idx) in suggestedQuestions"
              :key="idx"
              type="button"
              class="suggestion-chip"
              @click="sendMessage(q)"
            >
              {{ q }}
            </button>
          </div>
        </div>

        <!-- Input Box -->
        <div class="chat-input-area">
          <textarea
            v-model="inputMessage"
            class="chat-textarea"
            rows="2"
            placeholder="Ask anything about Void, Cloudflare, or edge APIs... (Enter to send)"
            :disabled="isLoading"
            @keydown="handleKeydown"
          ></textarea>
          <button
            type="button"
            class="send-btn"
            :disabled="isLoading || !inputMessage.trim()"
            @click="() => sendMessage()"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-5 h-5">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.void-gemini-chatbot-root {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 9999;
  font-family: var(--vp-font-family-base, sans-serif);
}

/* Floating Button */
.chat-trigger-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 9999px;
  background: linear-gradient(135deg, #4f30e8 0%, #7d88ff 100%);
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.2);
  box-shadow: 0 8px 24px rgba(79, 48, 232, 0.45);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.chat-trigger-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 28px rgba(79, 48, 232, 0.6);
}

.chat-trigger-btn.is-open {
  background: #1e1b4b;
  border-color: rgba(125, 136, 255, 0.4);
}

.chat-trigger-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-trigger-label {
  font-weight: 600;
  font-size: 14px;
}

.chat-trigger-badge {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.22);
  font-weight: 600;
  letter-spacing: 0.02em;
}

/* Chat Window Panel */
.chat-window-panel {
  position: absolute;
  bottom: 56px;
  right: 0;
  width: 440px;
  max-width: calc(100vw - 32px);
  height: 620px;
  max-height: calc(100vh - 100px);
  background: var(--vp-c-bg, #18181b);
  border: 1px solid var(--vp-c-divider, rgba(255, 255, 255, 0.14));
  border-radius: 16px;
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Header */
.chat-header {
  padding: 14px 16px;
  background: var(--vp-c-bg-soft, #1e1e24);
  border-bottom: 1px solid var(--vp-c-divider, rgba(255, 255, 255, 0.1));
}

.chat-header-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.chat-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.chat-avatar {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: linear-gradient(135deg, #4f30e8, #7d88ff);
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-header-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-text-1, #fff);
  line-height: 1.2;
}

.chat-header-subtitle {
  margin: 0;
  font-size: 11px;
  color: var(--vp-c-text-2, #a1a1aa);
}

.chat-header-actions {
  display: flex;
  gap: 4px;
}

.header-icon-btn {
  background: transparent;
  border: none;
  color: var(--vp-c-text-2, #a1a1aa);
  padding: 6px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}

.header-icon-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--vp-c-text-1, #fff);
}

/* Controls Bar */
.chat-controls-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.control-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.control-label {
  color: var(--vp-c-text-2, #888);
  font-weight: 500;
  font-size: 11px;
}

.control-select {
  background: var(--vp-c-bg, #111);
  color: var(--vp-c-text-1, #eee);
  border: 1px solid var(--vp-c-divider, rgba(255, 255, 255, 0.15));
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 11px;
  cursor: pointer;
  max-width: 175px;
}

.search-grounding-toggle {
  margin-left: auto;
}

.search-toggle-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--vp-c-text-1, #eee);
  cursor: pointer;
  padding: 3px 6px;
  border-radius: 6px;
  background: rgba(79, 48, 232, 0.12);
  border: 1px solid rgba(79, 48, 232, 0.3);
}

.search-checkbox {
  cursor: pointer;
}

.search-icon {
  font-size: 10px;
}

.search-text {
  font-weight: 500;
}

/* Messages Area */
.chat-messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--vp-c-bg, #0f0f11);
}

.chat-bubble-wrapper {
  display: flex;
  flex-direction: column;
}

.chat-bubble-wrapper.is-user {
  align-items: flex-end;
}

.chat-bubble-wrapper.is-model {
  align-items: flex-start;
}

.chat-bubble {
  max-width: 88%;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.user-bubble {
  background: linear-gradient(135deg, #4f30e8 0%, #6343f1 100%);
  color: #ffffff;
  border-bottom-right-radius: 2px;
}

.model-bubble {
  background: var(--vp-c-bg-soft, #1e1e24);
  color: var(--vp-c-text-1, #f4f4f5);
  border: 1px solid var(--vp-c-divider, rgba(255, 255, 255, 0.1));
  border-bottom-left-radius: 2px;
}

.model-bubble.has-error {
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.3);
  color: #fca5a5;
}

.model-meta-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 10px;
}

.model-badge {
  background: rgba(255, 255, 255, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--vp-font-family-mono, monospace);
  color: var(--vp-c-text-2, #a1a1aa);
}

.grounded-tag {
  color: #38bdf8;
  font-weight: 500;
}

.msg-time {
  margin-left: auto;
  font-size: 10px;
  color: var(--vp-c-text-3, #71717a);
}

.user-meta-footer {
  text-align: right;
  margin-top: 4px;
}

/* Grounding Sources */
.grounding-sources-section {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--vp-c-divider, rgba(255, 255, 255, 0.1));
}

.grounding-sources-title {
  font-size: 11px;
  font-weight: 600;
  color: #38bdf8;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
}

.grounding-sources-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.grounding-source-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(56, 189, 248, 0.08);
  border: 1px solid rgba(56, 189, 248, 0.2);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
  color: #38bdf8;
  text-decoration: none;
  transition: background 0.15s, border-color 0.15s;
}

.grounding-source-chip:hover {
  background: rgba(56, 189, 248, 0.16);
  border-color: rgba(56, 189, 248, 0.4);
  text-decoration: underline;
}

.source-index {
  background: rgba(56, 189, 248, 0.2);
  border-radius: 9999px;
  width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: bold;
}

.source-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Markdown styling */
:deep(.chat-code-block) {
  background: #09090b;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  margin: 6px 0;
  overflow-x: auto;
  font-family: var(--vp-font-family-mono, monospace);
}

:deep(.chat-inline-code) {
  background: rgba(255, 255, 255, 0.1);
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 12px;
  font-family: var(--vp-font-family-mono, monospace);
}

:deep(.chat-ul) {
  padding-left: 16px;
  margin: 6px 0;
}

:deep(.chat-li) {
  margin: 2px 0;
}

/* Thinking Indicator */
.loading-bubble {
  display: flex;
  align-items: center;
  gap: 8px;
}

.thinking-dots {
  display: flex;
  gap: 4px;
}

.thinking-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #7d88ff;
  animation: bounce 1.4s infinite ease-in-out both;
}

.thinking-dots span:nth-child(1) { animation-delay: -0.32s; }
.thinking-dots span:nth-child(2) { animation-delay: -0.16s; }

@keyframes bounce {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}

.thinking-label {
  font-size: 12px;
  color: var(--vp-c-text-2, #a1a1aa);
}

/* Suggestions Bar */
.chat-suggestions-bar {
  padding: 8px 14px;
  background: var(--vp-c-bg-soft, #1e1e24);
  border-top: 1px solid var(--vp-c-divider, rgba(255, 255, 255, 0.08));
}

.suggestions-hint {
  font-size: 10px;
  color: var(--vp-c-text-3, #71717a);
  display: block;
  margin-bottom: 4px;
}

.suggestions-scroll {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.suggestion-chip {
  background: var(--vp-c-bg, #111);
  border: 1px solid var(--vp-c-divider, rgba(255, 255, 255, 0.12));
  color: var(--vp-c-text-2, #cbd5e1);
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 9999px;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.15s;
}

.suggestion-chip:hover {
  background: rgba(79, 48, 232, 0.15);
  border-color: rgba(79, 48, 232, 0.4);
  color: var(--vp-c-text-1, #fff);
}

/* Input Area */
.chat-input-area {
  padding: 10px 12px;
  background: var(--vp-c-bg-soft, #1e1e24);
  border-top: 1px solid var(--vp-c-divider, rgba(255, 255, 255, 0.1));
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.chat-textarea {
  flex: 1;
  background: var(--vp-c-bg, #09090b);
  border: 1px solid var(--vp-c-divider, rgba(255, 255, 255, 0.15));
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--vp-c-text-1, #fff);
  resize: none;
  font-family: inherit;
  line-height: 1.4;
}

.chat-textarea:focus {
  outline: none;
  border-color: #7d88ff;
  box-shadow: 0 0 0 2px rgba(125, 136, 255, 0.2);
}

.send-btn {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: #4f30e8;
  color: #fff;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
}

.send-btn:hover:not(:disabled) {
  background: #6343f1;
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Animations */
.chat-fade-enter-active,
.chat-fade-leave-active {
  transition: opacity 0.2s, transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.chat-fade-enter-from,
.chat-fade-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.96);
}
</style>
