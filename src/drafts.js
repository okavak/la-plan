// Text answers are typed slowly and saved after a pause. Until the server has accepted the value,
// the text field keeps showing what the person typed, whatever the stored answer says: a repaint
// (another person's change, a poll, a tap elsewhere) must never wipe unsent text.

export function createDrafts() {
  const drafts = new Map();
  return {
    set: (key, value) => { drafts.set(key, value); },
    has: (key) => drafts.has(key),
    get: (key) => drafts.get(key),
    clear: (key) => { drafts.delete(key); },
    /** What the field should show: the draft if there is one, else the stored answer. */
    shown: (key, answers) => (drafts.has(key) ? drafts.get(key) : (answers[key] ?? '')),
  };
}

/** The small status line under a text field. `typing` means keystrokes not yet handed to the sync engine. */
export function fieldLabel({ typing, pending, rejected, saved }) {
  if (rejected) return `Kaydedilemedi: ${rejected}`;
  if (typing) return 'Yazılıyor…';
  if (pending) return 'Kaydediliyor…';
  return saved ? 'Kaydedildi' : '';
}
