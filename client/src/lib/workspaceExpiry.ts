// datetime-local edits use the browser timezone while the API stores an exact UTC instant.
export function expiryInputValue(value: string | null | undefined): string {
  if (!value) return '';
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return '';
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
}

export function expiryPayload(value: string): string | null {
  if (!value) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  const instant = new Date(value);
  if (!parts || !Number.isFinite(instant.getTime()) || instant.getFullYear() !== Number(parts[1]) || instant.getMonth() + 1 !== Number(parts[2]) || instant.getDate() !== Number(parts[3]) || instant.getHours() !== Number(parts[4]) || instant.getMinutes() !== Number(parts[5]) || instant.getSeconds() !== Number(parts[6] || 0)) throw new Error('Enter a valid expiry date and time, or leave it empty for no expiry.');
  return instant.toISOString();
}
