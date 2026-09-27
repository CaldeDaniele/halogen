type Listener<P> = (payload: P) => void;

/** Typed pub/sub bus. Listener errors are isolated so one bad system can't break the frame. */
export class Events<M extends Record<string, any>> {
  private map = new Map<keyof M, Set<Listener<any>>>();
  on<K extends keyof M>(key: K, fn: Listener<M[K]>): () => void {
    let set = this.map.get(key);
    if (!set) this.map.set(key, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
  emit<K extends keyof M>(key: K, payload: M[K]) {
    const set = this.map.get(key);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (e) { console.error(`[events] listener for ${String(key)} threw`, e); }
    }
  }
  clear() { this.map.clear(); }
}
