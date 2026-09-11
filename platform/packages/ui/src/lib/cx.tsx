import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export default function cx(...inputs: ReadonlyArray<ClassValue>) {
  return twMerge(clsx(inputs));
}
