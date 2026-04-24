import { defineHandler, type InferProps } from 'void';
import { defaultSandboxCode, sampleRequests } from '../lib/sandbox-demo';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(() => {
  return {
    defaultCode: defaultSandboxCode,
    sampleRequests,
  };
});
