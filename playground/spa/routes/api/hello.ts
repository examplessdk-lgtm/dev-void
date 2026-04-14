import { defineHandler } from 'void';

export const GET = defineHandler(() => {
  return { message: 'Hello from Void!', timestamp: Date.now() };
});
