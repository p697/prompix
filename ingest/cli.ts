import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogSchema } from '../packages/schema/catalog.ts';
import { fetchSource, parsePromptsCSV, source } from './collector.ts';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.env.PROMPIX_CONTENT_DIR ?? join(homedir(),'.local/share/prompix/content'));
const rel = relative(repository,root);
if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Content output must be outside the repository');
const [command, ...args] = process.argv.slice(2);
async function atomic(path:string, value:unknown) {
  await mkdir(dirname(path), {recursive:true});
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value,null,2)+'\n');
  await rename(temporary,path);
}
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
    const catalog=catalogSchema.parse(JSON.parse(await readFile(resolve(args[0]),'utf8')));
    if (command==='validate') { console.log(JSON.stringify({valid:true,version:catalog.version,count:catalog.prompts.length})); return; }
    // Local staging is intentionally separate from remote deployment and activation.
    const output=join(root,'releases',catalog.version);
    const serialized=JSON.stringify(catalog,null,2)+'\n';
    const digest=createHash('sha256').update(serialized).digest('hex');
    await mkdir(output,{recursive:true});
    const target=join(output,'catalog.json');
    try {
      const existing=await readFile(target,'utf8');
      if (existing!==serialized) throw new Error('Version already exists with different content; use a new version');
    } catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
    await atomic(target,catalog);
    await atomic(join(output,'manifest.json'),{schemaVersion:1,version:catalog.version,count:catalog.prompts.length,sha256:digest,catalog:'catalog.json'});
    console.log(JSON.stringify({output,count:catalog.prompts.length,sha256:digest,published:false})); return;
  }
  throw new Error('Commands: collect --source prompts-chat | validate <catalog.json> | stage <catalog.json>');
}
run().catch(error=>{ console.error(error instanceof Error ? error.message : String(error)); process.exitCode=1; });
