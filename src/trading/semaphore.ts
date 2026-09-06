export class Semaphore {
  private queue: Array<() => void> = [];
  private available: number;

  constructor(available: number) {
    this.available = available;
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (this.available > 0) {
        this.available--;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.available++;
    }
  }

  getAvailable(): number {
    return this.available;
  }
}
