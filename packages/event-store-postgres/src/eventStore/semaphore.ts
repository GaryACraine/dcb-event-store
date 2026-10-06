/**
 * At most `limit` pieces of work at a time; the rest wait their turn, first come first served (phase 21). `Infinity`
 * never waits. Used to cap the connections a store's subscriptions and a consumer's processors borrow at once, as
 * Marten's async daemon does (`MaxConcurrentEventLoadsPerDatabase`, `MaxConcurrentBatchWritesPerDatabase`).
 */
export class Semaphore {
    private active = 0
    private readonly waiting: (() => void)[] = []

    constructor(readonly limit: number) {
        if (!(limit >= 1)) throw new Error(`A concurrency cap must be at least 1 (got ${limit})`)
    }

    async run<T>(work: () => Promise<T>): Promise<T> {
        await this.acquire()
        try {
            return await work()
        } finally {
            this.release()
        }
    }

    private acquire(): Promise<void> {
        if (this.active < this.limit) {
            this.active++
            return Promise.resolve()
        }
        return new Promise(resolve => this.waiting.push(resolve))
    }

    private release(): void {
        // Hand the slot straight to the next in line, so a newcomer can't overtake it.
        const next = this.waiting.shift()
        if (next) next()
        else this.active--
    }
}
