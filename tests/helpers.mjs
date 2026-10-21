// Shared test doubles. Not matched by the `tests/*.test.mjs` glob.

export function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

/** Timers that only run when the test says so. */
export function manualTimers() {
  let id = 0;
  const scheduled = new Map();
  return {
    set: (fn, ms) => { const i = ++id; scheduled.set(i, { fn, ms }); return i; },
    clear: (i) => { scheduled.delete(i); },
    list: () => [...scheduled.values()],
    /** Run the oldest timer (optionally only one with this delay); false when none matches. */
    async fire(ms) {
      for (const [i, t] of scheduled) {
        if (ms === undefined || t.ms === ms) {
          scheduled.delete(i);
          await t.fn();
          return true;
        }
      }
      return false;
    },
  };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every pending promise callback run. */
export const settle = () => new Promise((resolve) => setImmediate(resolve));
