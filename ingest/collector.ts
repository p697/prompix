import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';

// Only reviewed public data sources belong here; website-internal APIs are excluded.
export const source = {
  id: 'prompts-chat',
  revision: 'bd4ed9313fdb1204e8c256d709d13694f72581de',
  license: 'CC0-1.0',
  repository: 'https://github.com/f/prompts.chat'
} as const;

export function parsePromptsCSV(csv: string) {
  const rows = parse(csv, {columns:true, bom:true, skip_empty_lines:true}) as Record<string,string>[];
  const seen = new Set<string>();
  const drafts: Record<string,unknown>[] = [];
  const rejected: {row:number; reason:string}[] = [];
  rows.forEach((row, index) => {
    if (!row.act?.trim() || !row.prompt?.trim()) { rejected.push({row:index+2, reason:'Missing title or prompt'}); return; }
    // Preserve unknown modalities for review; do not guess from a title.
    const kind = ({TEXT:'text', IMAGE:'image', VIDEO:'video', WEB:'web'} as Record<string,string>)[row.type?.toUpperCase()];
    if (!kind) { rejected.push({row:index+2, reason:`Unknown kind: ${row.type ?? 'missing'}`}); return; }
    const fingerprint = createHash('sha256').update(row.prompt.normalize('NFKC').replace(/\s+/g,' ').trim()).digest('hex');
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    drafts.push({
      id:`pc-${fingerprint.slice(0,20)}`, kind, title:row.act.trim(), prompt:row.prompt.trim(),
      source:{id:source.id, name:'prompts.chat', url:`${source.repository}/blob/${source.revision}/prompts.csv`, author:row.contributor || 'prompts.chat contributors', license:source.license, revision:source.revision, method:'original'},
      reviewStatus:'draft', missing:['summary','tags','example','preview','model/tool verification']
    });
  });
  return {drafts,rejected};
}

export async function fetchSource(): Promise<string> {
  const url = `https://raw.githubusercontent.com/f/prompts.chat/${source.revision}/prompts.csv`;
  let lastError: unknown;
  for (let attempt=0; attempt<3; attempt++) {
    try {
      const response = await fetch(url, {signal:AbortSignal.timeout(20_000), redirect:'error'});
      if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
      if (!response.body) throw new Error('Empty body');
      const chunks: Uint8Array[] = []; let length=0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        length += chunk.byteLength;
        if (length>20_000_000) throw new Error('Source exceeds 20 MB limit');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) { lastError=error; if (attempt<2) await new Promise(resolve=>setTimeout(resolve,500*(attempt+1))); }
  }
  throw lastError;
}
