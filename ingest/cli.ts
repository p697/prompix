import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogSchema } from '../packages/schema/catalog.ts';
import { fetchSource, parsePromptsCSV, source } from './collector.ts';
import { atomic, writeCatalog } from './publication.ts';
import { assertLibraryDownloadSize } from './library.ts';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.env.PROMPIX_CONTENT_DIR ?? join(homedir(),'.local/share/prompix/content'));
const rel = relative(repository,root);
if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Content output must be outside the repository');
const [command, ...args] = process.argv.slice(2);
async function run() {
  if (command==='collect') {
    if (args[0]!=='--source' || args[1]!==source.id) throw new Error('Use collect --source prompts-chat');
    const result = parsePromptsCSV(await fetchSource());
    if (!result.drafts.length) throw new Error('No valid drafts; previous snapshot preserved');
    const output=join(root,'drafts',`${source.id}.json`);
    await atomic(output,{source, ...result});
    console.log(JSON.stringify({drafts:result.drafts.length,rejected:result.rejected.length,output,published:false}));
    return;
  }
  if (command==='validate' || command==='stage') {
    if (!args[0]) throw new Error(`Use ${command} <catalog.json>`);
    const input=await readFile(resolve(args[0]));
    const catalog=catalogSchema.parse(JSON.parse(input.toString()));
    if (command==='validate') { assertLibraryDownloadSize(input); console.log(JSON.stringify({valid:true,version:catalog.version,count:catalog.prompts.length})); return; }
    // Local staging is intentionally separate from remote deployment and activation.
    const output=join(root,'releases',catalog.version);
    const target=join(output,'catalog.json');
    const {bytes}=await writeCatalog(target,catalog);
    const digest=createHash('sha256').update(bytes).digest('hex');
    await atomic(join(output,'manifest.json'),{schemaVersion:1,version:catalog.version,count:catalog.prompts.length,sha256:digest,catalog:'catalog.json'});
    console.log(JSON.stringify({output,count:catalog.prompts.length,sha256:digest,published:false})); return;
  }
  throw new Error('Commands: collect --source prompts-chat | validate <catalog.json> | stage <catalog.json>');
}
run().catch(error=>{ console.error(error instanceof Error ? error.message : String(error)); process.exitCode=1; });
