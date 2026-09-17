export function proxyCapabilityEnabled(value: string | undefined, capability: string): boolean {
  if (capability === 'sandbox') {
    return false;
  }
  if (!value) {
    return true;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)[capability] === true
    );
  } catch {
    return false;
  }
}
