/** Retry only operations whose caller has established that replay is safe. */
export function transientConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN", "57P01", "57P02", "57P03", "53300", "08006", "08001"].includes(code ?? "")
    || /^(Connection terminated unexpectedly|Connection terminated due to connection timeout|timeout expired)$/i.test(error.message);
}

export async function retryConnection<T>(operation: () => Promise<T>, sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 3 || !transientConnectionError(error)) throw error;
      await sleep([1000, 3000, 8000][attempt]);
    }
  }
}

/** Call only for read-only work or transactions proven rolled back before COMMIT. */
export function transientQueryError(error: unknown): boolean {
  return transientConnectionError(error) || (error instanceof Error &&
    (error.message === "Query read timeout" || ["57014", "55P03", "40001", "40P01"].includes((error as NodeJS.ErrnoException).code ?? "")));
}
export async function retrySafeDatabase<T>(operation: () => Promise<T>, safe: (error: unknown) => boolean,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 3 || !safe(error) || !transientQueryError(error)) throw error;
      await sleep([1000, 3000, 8000][attempt]);
    }
  }
}
