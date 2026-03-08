<script setup lang="ts">
import { useForm } from "void/vue";
import type { Props } from "./db.server";

defineProps<Props>();

const form = useForm("/db", {
  intent: "create",
  title: "",
  body: "",
});

const deleteForm = useForm("/db", {
  intent: "delete",
  id: 0,
});

function deleteNote(id: number) {
  deleteForm.data.id = id;
  deleteForm.post();
}
</script>
<template>
  <div>
    <h1>DB (D1)</h1>
    <p>SQLite database via <code>void/db</code>.</p>

    <h2>Add Note</h2>
    <form @submit.prevent="form.post()">
      <div>
        <label>Title: </label>
        <input v-model="form.data.title" placeholder="Note title" required />
      </div>
      <div style="margin-top: 5px">
        <label>Body: </label>
        <input v-model="form.data.body" placeholder="Note body" />
      </div>
      <button type="submit" :disabled="form.processing" style="margin-top: 5px">
        {{ form.processing ? "Saving..." : "Add Note" }}
      </button>
    </form>

    <h2>Notes ({{ notes.length }})</h2>
    <table v-if="notes.length">
      <thead>
        <tr>
          <th style="text-align: left">ID</th>
          <th style="text-align: left">Title</th>
          <th style="text-align: left">Body</th>
          <th style="text-align: left">Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="note in notes" :key="note.id">
          <td>{{ note.id }}</td>
          <td>{{ note.title }}</td>
          <td>{{ note.body }}</td>
          <td>{{ note.createdAt }}</td>
          <td>
            <button @click="deleteNote(note.id)" :disabled="deleteForm.processing">Delete</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else><em>No notes yet. Add one above.</em></p>
  </div>
</template>
