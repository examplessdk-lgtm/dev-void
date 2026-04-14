import { defineMiddleware } from 'void';

declare module 'void' {
  interface CloudContextVariables {
    shared: { appName: string };
  }
}

export default defineMiddleware(async (c, next) => {
  c.set('shared', {
    appName: 'Vue Pages Demo',
  });
  await next();
});
