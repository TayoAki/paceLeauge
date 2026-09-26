/**
 * Serializes async critical sections in the JS runtime. The recorder's background task and
 * UI actions share one JS thread, so this is enough to keep journal writes ordered.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
