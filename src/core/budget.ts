/** FIFO capped set: adding past the cap evicts (and reports) the oldest. */
export class Budget<T> {
  readonly items = new Set<T>();
  constructor(public cap: number, private onEvict: (item: T) => void) {}
  get size() { return this.items.size; }
  add(item: T) {
    this.items.add(item);
    while (this.items.size > this.cap) {
      const oldest = this.items.values().next().value as T;
      this.items.delete(oldest);
      this.onEvict(oldest);
    }
  }
  remove(item: T) { this.items.delete(item); }
  clear() { this.items.clear(); }
}
