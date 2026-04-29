import { For } from 'solid-js';
import Counter from './_Counter.tsx' with { island: 'load' };
import PostForm from './_PostForm.tsx' with { island: 'load' };

interface Props {
  posts: Array<{ slug: string; title: string }>;
}

export default function BlogIndex(props: Props) {
  return (
    <div>
      <h1>Blog</h1>
      <Counter initial={0} />
      <h2>Posts</h2>
      <ul>
        <For each={props.posts}>
          {(post) => (
            <li>
              <a href={`/blog/${post.slug}`}>{post.title}</a>
            </li>
          )}
        </For>
      </ul>
      <h2>New Post</h2>
      <PostForm />
    </div>
  );
}
