/** Created only by a guard that runs before a provider invocation/reservation. */
export class ProviderAdmissionDenied extends Error {
  constructor() { super("Provider admission denied before external request"); }
}
export async function beforeProviderRequest(guard?: () => Promise<void>) {
  try { await guard?.(); }
  catch { throw new ProviderAdmissionDenied(); }
}
