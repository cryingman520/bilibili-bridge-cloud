import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('worker',{recursive:true});
await build({entryPoints:['src/index.js'],outfile:'worker/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',legalComments:'eof'});
await mkdir('dist/server',{recursive:true});await mkdir('dist/.openai',{recursive:true});
await copyFile('worker/index.js','dist/server/index.js');await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
console.log('Built Bilibili Bridge cloud worker');
