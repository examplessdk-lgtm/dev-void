<script lang="ts">
  import { Link, useForm } from "@void/svelte";
  import type { Props } from "./index.server.ts";

  let { users }: Props = $props();

  const form = useForm("/users", {
    name: "",
    email: "",
  });

  function handleSubmit(e) {
    e.preventDefault();
    return form.post();
  }
</script>

<div>
  <h1>Users</h1>

  <ul>
    {#each users as user (user.id)}
      <li>
        <Link href={`/users/${user.id}`} prefetch="visible">{user.name}</Link> ({user.email})
      </li>
    {/each}
  </ul>

  <h2>Add User</h2>
  <form onsubmit={handleSubmit}>
    <div>
      <label>Name: <input bind:value={form.data.name} /></label>
      {#if form.errors.name}
        <span style="color: red">{form.errors.name}</span>
      {/if}
    </div>
    <div>
      <label>Email: <input bind:value={form.data.email} /></label>
      {#if form.errors.email}
        <span style="color: red">{form.errors.email}</span>
      {/if}
    </div>
    <button type="submit" disabled={form.pending}>
      {form.pending ? "Saving..." : "Add User"}
    </button>
  </form>
</div>
