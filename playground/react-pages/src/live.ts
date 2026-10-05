import { defineLiveStream } from 'void/live';

export const live = defineLiveStream({
  id: 'react-pages-playground',
  allowAnonymousControl: true,
});

export const LIVE_PLAYGROUND_TOPIC = 'playground:react-pages';
