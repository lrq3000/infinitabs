export async function waitFor(predicate, { timeout = 3000, interval = 25, label = 'condition' } = {}) {
    const start = Date.now();

    while ((Date.now() - start) < timeout) {
        if (await predicate()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }

    throw new Error(`Timeout waiting for ${label}`);
}
