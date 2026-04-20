<script lang="ts">
  import { useIslandForm } from "@void/svelte";

  const form = useIslandForm({ title: "", body: "" });
</script>

<form onsubmit={(e) => { e.preventDefault(); return form.post("/blog"); }}>
  <div>
    <label for="title">Title:</label>
    <input id="title" bind:value={form.data.title} />
    {#if form.errors.title}
      <span style="color: red">{form.errors.title}</span>
    {/if}
  </div>
  <div>
    <label for="body">Body:</label>
    <textarea id="body" bind:value={form.data.body}></textarea>
    {#if form.errors.body}
      <span style="color: red">{form.errors.body}</span>
    {/if}
  </div>
  <button type="submit" disabled={form.pending}>
    {form.pending ? "Saving..." : "Add Post"}
  </button>
</form>
