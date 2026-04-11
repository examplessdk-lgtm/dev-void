import { HttpClient } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';

@Component({
  selector: 'app-smoke',
  template: `
    <h1>Smoke Test</h1>
    @if (data(); as d) {
      <p>
        D1 user: <span data-testid="d1-user">{{ d.user?.name ?? 'none' }}</span>
      </p>
      <p>
        KV value: <span data-testid="kv-value">{{ d.kvValue ?? 'none' }}</span>
      </p>
    }
  `,
})
export default class SmokePage {
  private http = inject(HttpClient);
  data = toSignal(
    this.http.get<{ user: { name: string } | null; kvValue: string | null }>('/api/smoke'),
  );
}
