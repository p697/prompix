import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePromptsCSV } from './collector.ts';
import { catalogSchema } from '../packages/schema/catalog.ts';
import { readFile } from 'node:fs/promises';

test('CSV preserves quoted newlines, attributes contributors, rejects missing/unknown kinds and deduplicates',()=>{
  const {drafts,rejected}=parsePromptsCSV('act,prompt,type,contributor\n"An idea","Write a story,\nwith a moon",TEXT,studio\nDuplicate,"Write a story, with a moon",TEXT,studio\nBad,,TEXT,studio\nUnknown,Hello,OTHER,studio\n');
  assert.equal(drafts.length,1); assert.equal(rejected.length,2);
  assert.equal(drafts[0].prompt,'Write a story,\nwith a moon');
  assert.equal((drafts[0].source as {author:string}).author,'studio');
  assert.equal(drafts[0].reviewStatus,'draft');
});
test('first-party catalog matches shipping contract and rejects duplicate IDs and unsupported schema',async()=>{
  const raw=JSON.parse(await readFile(new URL('../ios/Prompix/Resources/catalog.json',import.meta.url),'utf8'));
  const catalog=catalogSchema.parse(raw);
  assert.equal(catalog.version,'studio-004');
  assert.equal(catalog.prompts.length,30);
  assert.deepEqual([...new Set(catalog.prompts.map(i=>i.kind))].sort(),['image','text','web']);
  assert.equal(catalog.prompts.some(i=>i.media?.video),false);
  assert.equal(catalog.removedIDs?.length ?? 0,0);
  assert.equal(catalogSchema.safeParse({...raw,schemaVersion:2}).success,false);
  assert.equal(catalogSchema.safeParse({...raw,prompts:[raw.prompts[0],raw.prompts[0]]}).success,false);
  assert.equal(catalogSchema.safeParse({...raw,prompts:[{...raw.prompts[0],toolURL:'http://example.com'}]}).success,false);
});
