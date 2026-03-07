import { useForm } from "void/react";
import type { Props } from "./index.server";

export default function DbPage({ users, posts }: Props) {
  const userForm = useForm("/", {
    intent: "create-user",
    name: "",
    email: "",
  });

  const deleteUserForm = useForm("/", {
    intent: "delete-user",
    id: 0,
  });

  const postForm = useForm("/", {
    intent: "create-post",
    title: "",
    body: "",
    authorId: 0,
  });

  const deletePostForm = useForm("/", {
    intent: "delete-post",
    id: 0,
  });

  function deleteUser(id: number) {
    deleteUserForm.setData("id", id);
    deleteUserForm.post();
  }

  function deletePost(id: number) {
    deletePostForm.setData("id", id);
    deletePostForm.post();
  }

  return (
    <div>
      <h1>Database (PostgreSQL)</h1>
      <p>
        PostgreSQL via <code>void/db</code> + Drizzle ORM.
      </p>

      <h2>Add User</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          userForm.post();
        }}
      >
        <div>
          <label>Name: </label>
          <input
            value={userForm.data.name}
            onChange={(e) => userForm.setData("name", e.target.value)}
            placeholder="Name"
            required
          />
        </div>
        <div style={{ marginTop: 5 }}>
          <label>Email: </label>
          <input
            value={userForm.data.email}
            onChange={(e) => userForm.setData("email", e.target.value)}
            placeholder="Email"
            required
          />
        </div>
        <button type="submit" disabled={userForm.processing} style={{ marginTop: 5 }}>
          {userForm.processing ? "Saving..." : "Add User"}
        </button>
      </form>

      <h2>Users ({users.length})</h2>
      {users.length ? (
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>ID</th>
              <th style={{ textAlign: "left" }}>Name</th>
              <th style={{ textAlign: "left" }}>Email</th>
              <th style={{ textAlign: "left" }}>Active</th>
              <th style={{ textAlign: "left" }}>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.id}</td>
                <td>{user.name}</td>
                <td>{user.email}</td>
                <td>{user.active ? "Yes" : "No"}</td>
                <td>{String(user.createdAt)}</td>
                <td>
                  <button onClick={() => deleteUser(user.id)} disabled={deleteUserForm.processing}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>
          <em>No users yet.</em>
        </p>
      )}

      <hr />

      <h2>Add Post</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          postForm.post();
        }}
      >
        <div>
          <label>Title: </label>
          <input
            value={postForm.data.title}
            onChange={(e) => postForm.setData("title", e.target.value)}
            placeholder="Post title"
            required
          />
        </div>
        <div style={{ marginTop: 5 }}>
          <label>Body: </label>
          <input
            value={postForm.data.body}
            onChange={(e) => postForm.setData("body", e.target.value)}
            placeholder="Post body"
          />
        </div>
        <div style={{ marginTop: 5 }}>
          <label>Author: </label>
          <select
            value={postForm.data.authorId}
            onChange={(e) => postForm.setData("authorId", Number(e.target.value))}
            required
          >
            <option value={0} disabled>
              Select author
            </option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={postForm.processing} style={{ marginTop: 5 }}>
          {postForm.processing ? "Saving..." : "Add Post"}
        </button>
      </form>

      <h2>Posts ({posts.length})</h2>
      {posts.length ? (
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>ID</th>
              <th style={{ textAlign: "left" }}>Title</th>
              <th style={{ textAlign: "left" }}>Body</th>
              <th style={{ textAlign: "left" }}>Author</th>
              <th style={{ textAlign: "left" }}>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {posts.map((post) => (
              <tr key={post.id}>
                <td>{post.id}</td>
                <td>{post.title}</td>
                <td>{post.body}</td>
                <td>{post.author}</td>
                <td>{String(post.createdAt)}</td>
                <td>
                  <button onClick={() => deletePost(post.id)} disabled={deletePostForm.processing}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>
          <em>No posts yet. Create a user first, then add a post.</em>
        </p>
      )}
    </div>
  );
}
