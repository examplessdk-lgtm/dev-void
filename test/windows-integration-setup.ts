import { beforeEach } from 'vite-plus/test';
import { createWindowsResourceReporter } from './windows-resource-diagnostics.ts';

// Capture at the first failed test, before suite teardown removes browsers and dev servers.
// Concurrent failures share one bounded snapshot per file, rather than starting more processes.
const reportResources = createWindowsResourceReporter();
beforeEach(({ onTestFailed }) => {
  onTestFailed(reportResources);
});
