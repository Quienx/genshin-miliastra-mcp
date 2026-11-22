// Offline check of handler titles: `// @title` lines above a handler become the note over its event node, kept through
// the write into a save, and read_graph shows them. tests/fixtures/titled-handlers.gia is SOURCE below compiled by
// genshin-ts (bin/gsts.mjs --noinject).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inject,withTitles} from '../src/adapter.mjs';
import {readGraph} from '../src/scene/graph-read.mjs';

const SOURCE=`import { g } from 'genshin-ts/runtime/core'
const SAY = 'CC_say'
// @title On creation: greet
g.server({ id: 1073741825, name: 'Titled' }).on('whenEntityIsCreated', (_evt, f) => {
  f.printString('a')
})
  // @title Signal: say
  // @title second line

  .onSignal(SAY, (evt, f) => {
    f.printString('b')
  })
  .on('whenTimerIsTriggered', (evt, f) => {
    f.printString('c')
  })
`;
const dir=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures');
const gia=fs.readFileSync(path.join(dir,'titled-handlers.gia')),gil=fs.readFileSync(path.join(dir,'editor-2026-10-13-signal4.gil'));
assert.equal(withTitles(gia,SOURCE.replace(/\/\/ @title.*\n/g,'')),gia,'a source without titles leaves the graph as it is');

const [graph]=readGraph(inject(gil,gia,1073741825,false,SOURCE),{graphId:1073741825}).graphs;
const notes=graph.nodes.filter(n=>n.comment).map(n=>[n.node,n.comment]);
assert.deepEqual(notes,[['When Entity Is Created','On creation: greet'],['monitor CC_say','Signal: say\nsecond line']],JSON.stringify(notes));
assert.equal(graph.nodeCount,6,'titles add no node');

const code=e=>{try{withTitles(gia,e);}catch(x){return x.code;}};
assert.equal(code("// @title lost\nconst x = 1\n"),'TITLE_WITHOUT_HANDLER','a title over no handler fails');
assert.equal(code("// @title t\n.onSignal(NOPE, (evt, f) => {})\n"),'TITLE_WITHOUT_HANDLER','a signal constant the source does not set fails');
assert.equal(code("// @title t\n.onSignal('SS_other', (evt, f) => {})\n"),'TITLE_WITHOUT_HANDLER','a handler the graph does not have fails');
console.log('graph-titles: ok');
