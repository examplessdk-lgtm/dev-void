import { boolean, defineEnv, oneOf, string, url } from 'void/env';

export default defineEnv({
  APP_NAME: string(),
  SECRET_KEY: string(),
  FEATURE_FLAG: boolean().default(false),
  API_URL: url(),
  LOG_LEVEL: oneOf(['debug', 'info', 'warn', 'error']).default('info'),
});
