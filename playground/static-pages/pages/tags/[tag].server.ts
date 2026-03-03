import { defineHandler } from "void";
import { tags } from "virtual:tags";

export interface Props {
  tag: string;
}

export const prerender = true;

export function getPrerenderPaths() {
  return tags.map((tag: string) => ({ tag }));
}

export const loader = defineHandler<Props>((c) => {
  return { tag: c.req.param("tag") };
});
