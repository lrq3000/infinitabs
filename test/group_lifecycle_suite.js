const assert = require('node:assert/strict');

// Shared only by the focused Node suites. No production timer or test framework
// is introduced; this referenced watchdog makes unresolved promises observable.
class GroupLifecycleSuite {
    constructor(name, expectedCases, timeoutMs = 120000) {
        assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'Watchdog timeout must be positive');
        this.name = name;
        this.expectedCases = expectedCases;
        this.selectedCases = 0;
        this.completedCases = 0;
        this.failures = [];
        this.watchdog = setTimeout(() => {
            console.error(`FAIL ${name} watchdog: suite unfinished; completedCases=${this.completedCases}`);
            process.exit(1);
        }, timeoutMs); // Intentionally not unref(): a hung promise cannot keep Node alive.
    }

    async check(name, run, cleanup = () => {}) {
        if (process.argv[2] && !name.includes(process.argv[2])) return;
        this.selectedCases++;
        try { await run(); console.log(`PASS ${name}`); }
        catch (error) { this.failures.push(`${name}: ${error.stack}`); }
        finally { this.completedCases++; cleanup(); }
    }

    async run(main) {
        try {
            await main();
            assert.deepEqual(this.failures, [], `${this.name} regressions`);
            assert.ok(this.selectedCases > 0, 'Filter must select a meaningful case');
            assert.equal(this.completedCases, process.argv[2] ? this.selectedCases : this.expectedCases,
                'Every selected case must complete');
            console.log(`COMPLETE ${this.name} suite: completedCases=${this.completedCases}`);
        } catch (error) {
            console.error(error);
            process.exitCode = 1;
        } finally { clearTimeout(this.watchdog); }
    }

    static async waitFor(promise, diagnostic, timeoutMs = 2000) {
        let timer;
        try {
            return await Promise.race([promise, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(diagnostic)), timeoutMs);
            })]);
        } finally { clearTimeout(timer); }
    }
}

module.exports = { GroupLifecycleSuite };
