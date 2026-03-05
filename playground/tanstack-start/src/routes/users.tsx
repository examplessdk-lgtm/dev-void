import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { db } from "void/db";

const getUsers = createServerFn().handler(async () => {
  return db.list("users");
});

export const Route = createFileRoute("/users")({
  loader: () => getUsers(),
  component: UsersPage,
});

function UsersPage() {
  const users = Route.useLoaderData();

  return (
    <div style={{ padding: "16px" }}>
      <h1>Users</h1>
      <p>Fetched from D1 via a server function:</p>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Email</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>{user.id}</td>
              <td>{user.name}</td>
              <td>{user.email}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
