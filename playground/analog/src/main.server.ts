import '@angular/platform-server/init';
import { render } from '@analogjs/router/server';
import { config } from './app/app.config.server.ts';
import { App } from './app/app.ts';

export default render(App, config);
