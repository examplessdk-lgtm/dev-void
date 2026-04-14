declare module 'markdown-it-attrs' {
  const plugin: (md: any, ...args: any[]) => void;
  export default plugin;
}

declare module 'markdown-it-emoji' {
  export const full: (md: any) => void;
}

declare module 'markdown-it-container' {
  const plugin: (md: any, name: string, options: any) => void;
  export default plugin;
}
