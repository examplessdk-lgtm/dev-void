<script setup lang="ts">
import { useRouter } from '@void/vue';
import { auth } from 'void/client';
import { ref } from 'vue';
import type { Props } from './auth.server';

defineProps<Props>();

const router = useRouter();
const response = ref('');
const tab = ref<'login' | 'register'>('login');

const loginEmail = ref('');
const loginPassword = ref('');
const regEmail = ref('');
const regPassword = ref('');
const regName = ref('');

function showResponse(label: string, data: unknown) {
  response.value = `${label}:\n${JSON.stringify(data, null, 2)}`;
}

async function handleRegister() {
  try {
    const u = await auth.signUp.email({
      email: regEmail.value,
      password: regPassword.value,
      name: regName.value,
    });
    showResponse('signUp.email (200)', u);
    regEmail.value = '';
    regPassword.value = '';
    regName.value = '';
    router.refresh();
  } catch (err) {
    showResponse('signUp.email (error)', err);
  }
}

async function handleLogin() {
  try {
    const u = await auth.signIn.email({
      email: loginEmail.value,
      password: loginPassword.value,
    });
    showResponse('signIn.email (200)', u);
    loginEmail.value = '';
    loginPassword.value = '';
    router.refresh();
  } catch (err) {
    showResponse('signIn.email (error)', err);
  }
}

async function handleLogout() {
  await auth.signOut();
  response.value = 'Logged out';
  router.refresh();
}

async function handleProfile() {
  const res = await fetch('/api/profile');
  const data = await res.json();
  showResponse(`GET /api/profile (${res.status})`, data);
}
</script>
<template>
  <div>
    <h1>Auth</h1>
    <p>
      Authentication via <code>void/auth</code> + <code>void/client</code> with
      <code>auth.providers</code> configured in <code>void.json</code>.
    </p>
    <p>
      This playground enables <code>email</code> only by default so it works without OAuth secrets.
    </p>

    <div
      style="display: flex; align-items: center; border-bottom: 1px solid #ccc; margin-bottom: 15px"
    >
      <button
        @click="tab = 'login'"
        :style="{
          padding: '8px 16px',
          border: 'none',
          borderBottom: tab === 'login' ? '2px solid #333' : '2px solid transparent',
          background: 'none',
          fontWeight: tab === 'login' ? 'bold' : 'normal',
          cursor: 'pointer',
          fontFamily: 'monospace',
        }"
      >
        Login
      </button>
      <button
        @click="tab = 'register'"
        :style="{
          padding: '8px 16px',
          border: 'none',
          borderBottom: tab === 'register' ? '2px solid #333' : '2px solid transparent',
          background: 'none',
          fontWeight: tab === 'register' ? 'bold' : 'normal',
          cursor: 'pointer',
          fontFamily: 'monospace',
        }"
      >
        Register
      </button>
      <span style="margin-left: auto; padding: 8px 0; font-size: 0.9em">
        <template v-if="user">
          <strong>{{ user.name || user.email || user.id }}</strong>
          <span style="opacity: 0.7">
            ({{ user.emailVerified ? 'email verified' : 'email unverified' }})
          </span>
          <span v-if="session" style="opacity: 0.7"> session {{ session.id }}</span>
          &mdash;
          <button @click="handleLogout">Logout</button>
        </template>
        <template v-else>Not logged in</template>
      </span>
    </div>

    <section v-if="tab === 'login'">
      <h2>Email Login</h2>
      <form @submit.prevent="handleLogin">
        <div>
          <input v-model="loginEmail" type="email" placeholder="Email" required />
        </div>
        <div style="margin-top: 5px">
          <input v-model="loginPassword" type="password" placeholder="Password" required />
        </div>
        <button type="submit" style="margin-top: 5px">Login</button>
      </form>
    </section>

    <section v-if="tab === 'register'">
      <h2>Email Register</h2>
      <form @submit.prevent="handleRegister">
        <div>
          <input v-model="regEmail" type="email" placeholder="Email" required />
        </div>
        <div style="margin-top: 5px">
          <input v-model="regPassword" type="password" placeholder="Password" required />
        </div>
        <div style="margin-top: 5px">
          <input v-model="regName" type="text" placeholder="Name" required />
        </div>
        <button type="submit" style="margin-top: 5px">Register</button>
      </form>
    </section>

    <hr />

    <section>
      <h2>Protected Route</h2>
      <button @click="handleProfile">GET /api/profile</button>
      <p>Tests <code>requireAuth()</code> — returns 401 if not logged in.</p>
    </section>

    <section>
      <h2>Adding OAuth Providers</h2>
      <p>
        Add providers to <code>void.json</code>, for example
        <code>["email", "github", "google"]</code>.
      </p>
      <p>
        Then set <code>AUTH_GITHUB_CLIENT_ID</code> / <code>AUTH_GITHUB_CLIENT_SECRET</code> or the
        matching <code>AUTH_&lt;PROVIDER&gt;_CLIENT_ID</code> /
        <code>AUTH_&lt;PROVIDER&gt;_CLIENT_SECRET</code> env vars.
      </p>
    </section>

    <section v-if="response">
      <h2>Response</h2>
      <pre style="background: #f5f5f5; padding: 10px; overflow: auto; white-space: pre-wrap">{{
        response
      }}</pre>
    </section>
  </div>
</template>
