import { defineHandler } from 'void';
import { live } from '../../src/live.ts';

export const GET = defineHandler((c) => live.connect(c));

export const POST = defineHandler((c) => live.control(c));
