import { defineHandler } from 'void';

export const GET = defineHandler((c) => {
  return c.json({ message: 'Hello from Node.js!' });
});
