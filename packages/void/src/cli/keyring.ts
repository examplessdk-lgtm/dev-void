import { Entry } from '@napi-rs/keyring';

export function readKeyringPassword(service: string, account: string): string | null {
  try {
    return new Entry(service, account).getPassword();
  } catch {
    return null;
  }
}

export function writeKeyringPassword(service: string, account: string, password: string): boolean {
  try {
    new Entry(service, account).setPassword(password);
    return true;
  } catch {
    return false;
  }
}

export function deleteKeyringPassword(service: string, account: string): boolean {
  try {
    new Entry(service, account).deletePassword();
    return true;
  } catch {
    return false;
  }
}
