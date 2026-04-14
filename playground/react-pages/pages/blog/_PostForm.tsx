import { useIslandForm } from '@void/react';

export default function PostForm() {
  const form = useIslandForm({ title: '', body: '' });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.post('/blog');
      }}
    >
      <div>
        <label>Title:</label>
        <input value={form.data.title} onChange={(e) => form.setData('title', e.target.value)} />
        {form.errors.title && <span style={{ color: 'red' }}>{form.errors.title}</span>}
      </div>
      <div>
        <label>Body:</label>
        <textarea value={form.data.body} onChange={(e) => form.setData('body', e.target.value)} />
        {form.errors.body && <span style={{ color: 'red' }}>{form.errors.body}</span>}
      </div>
      <button type="submit" disabled={form.processing}>
        {form.processing ? 'Saving...' : 'Add Post'}
      </button>
    </form>
  );
}
