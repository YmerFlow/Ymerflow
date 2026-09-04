// Current cache namespace = the logged-in user's stable id, or "anon".
// Read from localStorage (the same source AuthContext hydrates from) so the
// value is always current, even right after a user switch with no page reload.
export function cacheNamespace() {
  try {
    const raw = localStorage.getItem('auth_user');
    if (!raw) return 'anon';
    const { id } = JSON.parse(raw);
    return id != null ? String(id) : 'anon';
  } catch {
    // Malformed auth_user must not silently poison the cache namespace —
    // fall back to anon rather than throwing inside a cache read/write.
    return 'anon';
  }
}
