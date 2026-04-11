import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-home',
  imports: [RouterLink],
  template: `
    <h1>Analog + Void</h1>
    <p>This playground demonstrates meta-framework integration.</p>
    <a routerLink="/smoke">Smoke Test</a>
  `,
})
export default class Home {}
