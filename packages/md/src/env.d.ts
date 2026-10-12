declare module 'markdown-it-attrs' {
  const plugin: (md: unknown, ...args: ReadonlyArray<unknown>) => void;
  export default plugin;
}

declare module 'markdown-it-emoji' {
  export const full: (md: unknown) => void;
}

declare module 'markdown-it-container' {
  const plugin: (md: unknown, name: string, options: unknown) => void;
  export default plugin;
}

declare module 'markdown-it-footnote' {
  const plugin: (md: unknown, ...args: ReadonlyArray<unknown>) => void;
  export default plugin;
}
