export type Listener<T> = (value: T) => void;

export class Emitter<T = void> {
  private listeners = new Set<Listener<T>>();

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}
