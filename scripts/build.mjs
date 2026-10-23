import {build} from 'esbuild';
await build({entryPoints:['src/plugin.tsx'],outfile:'desktop/plugin.js',bundle:true,format:'esm',platform:'browser',target:'chrome120',external:['react','react/jsx-runtime','@hermes/plugin-sdk'],sourcemap:false,legalComments:'none'});
console.log('Built desktop/plugin.js');
