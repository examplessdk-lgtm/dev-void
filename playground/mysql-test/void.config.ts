import { defineConfig } from 'void/config';

export default defineConfig({
  database: 'mysql',
  worker: {
    compatibility_date: '2026-02-24',
  },
});
