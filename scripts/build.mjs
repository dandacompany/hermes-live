import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
const developer=process.argv.includes('--dev-diagnostics');
const outfile=developer?'dist/developer/plugin.js':'desktop/plugin.js';
await build({define:{__HERMES_LIVE_DEV_DIAGNOSTICS__:String(developer)},entryPoints:['src/plugin.tsx'],outfile,bundle:true,format:'esm',platform:'browser',target:'chrome120',external:['react','react/jsx-runtime','@hermes/plugin-sdk'],loader:{'.wav':'dataurl'},sourcemap:false,minifySyntax:true,legalComments:'none'});
if(!developer){const result=await readFile(outfile,'utf8');for(const marker of ['/diagnostics/events','/diagnostics/detail','runtime.health'])if(result.includes(marker))throw new Error('Developer diagnostics leaked into distribution bundle');}
console.log(`Built ${outfile} (${developer?'local developer diagnostics':'distribution; diagnostics disabled'})`);
