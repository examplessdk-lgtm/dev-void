import { defineHandler } from 'void';
import { live } from '../../lib/live.ts';

export const GET = defineHandler((c) => live.connect(c));

export const POST = defineHandler((c) => live.control(c));
