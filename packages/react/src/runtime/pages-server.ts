import React, { type ComponentType } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { createSsrRouter, idleNavigationState } from 'void/pages-client';
import { renderBodyAttrs, renderHeadToString, renderHtmlAttrs } from 'void/pages-head';
import type { PageObject } from 'void/pages-protocol';
import { serializePageData } from 'void/pages-server';
import { ErrorsContext, NavigationContext, RouterContext, SharedContext } from './context.ts';

// oxlint-disable-next-line no-explicit-any -- component props are narrowed by generated route types
type ComponentModule = { default: ComponentType<any> };
const DEFERRED_SHELL_CANCEL_REASON = 'Void deferred shell complete';
const DEFERRED_SHELL_END_ID = '__VOID_DEFERRED_SHELL_END__';
const DEFERRED_SHELL_END_MARKER = `<template id="${DEFERRED_SHELL_END_ID}"></template>`;

export interface ReactPagesServerConfig {
  pageObj: PageObject;
  assetTags: { css: string; preloads: string; body: string };
  components: Record<string, () => Promise<ComponentModule>>;
  layoutTree: Record<string, Array<string>>;
  preambleScript?: string;
}

function createPendingDeferred(): Promise<never> {
  return new Promise(() => {});
}

function propsForReactRender(pageObj: PageObject): Record<string, unknown> {
  if (!pageObj.deferredKeys) {
    return pageObj.props;
  }
  const props = { ...pageObj.props };
  for (const key of Object.keys(pageObj.deferredKeys)) {
    props[key] = createPendingDeferred();
  }
  return props;
}

function textStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function concatStreams(streams: Array<ReadableStream<Uint8Array>>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      try {
        for (const stream of streams) {
          const reader = stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            controller.enqueue(value);
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function readDeferredShell(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const keepLength = DEFERRED_SHELL_END_MARKER.length - 1;

      const flush = (text: string) => {
        if (text) {
          controller.enqueue(encoder.encode(text));
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            flush(buffer);
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const markerIndex = buffer.indexOf(DEFERRED_SHELL_END_MARKER);
          if (markerIndex !== -1) {
            flush(buffer.slice(0, markerIndex));
            await reader.cancel(DEFERRED_SHELL_CANCEL_REASON);
            break;
          }

          if (buffer.length > keepLength) {
            flush(buffer.slice(0, -keepLength));
            buffer = buffer.slice(-keepLength);
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export async function renderReactPage({
  pageObj,
  assetTags,
  components,
  layoutTree,
  preambleScript = '',
}: ReactPagesServerConfig): Promise<ReadableStream<Uint8Array>> {
  const PageComponent = (await components[pageObj.component]()).default;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default),
  );
  const renderProps = propsForReactRender(pageObj);

  let element = React.createElement(PageComponent, renderProps);
  for (let i = layoutComponents.length - 1; i >= 0; i--) {
    element = React.createElement(layoutComponents[i], null, element);
  }

  element = React.createElement(
    RouterContext.Provider,
    { value: createSsrRouter(pageObj.url || '/') },
    React.createElement(
      NavigationContext.Provider,
      { value: idleNavigationState() },
      React.createElement(
        React.Suspense,
        { fallback: null },
        React.createElement(
          SharedContext.Provider,
          { value: pageObj.shared || {} },
          React.createElement(ErrorsContext.Provider, { value: pageObj.errors || {} }, element),
        ),
      ),
    ),
  );

  const renderElement = pageObj.deferredKeys
    ? React.createElement(
        React.Fragment,
        null,
        element,
        React.createElement('template', { id: DEFERRED_SHELL_END_ID }),
      )
    : element;

  const appStream = await renderToReadableStream(renderElement, {
    onError(error) {
      if (error === DEFERRED_SHELL_CANCEL_REASON) {
        return;
      }
      throw error;
    },
  });
  const renderedAppStream = pageObj.deferredKeys ? readDeferredShell(appStream) : appStream;
  const pageData = serializePageData(pageObj);
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : '';
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : '';
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : '';

  return concatStreams([
    textStream(`<!doctype html>
<html${htmlAttrs}>
<head>${headHtml}${preambleScript}${assetTags.css}${assetTags.preloads}</head>
<body${bodyAttrs}>
  <script id="__VOID_PAGE_DATA__" type="application/json">${pageData}</script>
  <div id="app">`),
    renderedAppStream,
    textStream(`</div>
  ${assetTags.body}
</body>
</html>`),
  ]);
}
