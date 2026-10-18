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
