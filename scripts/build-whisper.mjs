// Developer-only. Released apps carry these resources; users never compile an engine.
import {mkdir,readFile,writeFile,copyFile,chmod} from 'node:fs/promises';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {join,resolve} from 'node:path';
const windows=process.platform==='win32'&&process.arch==='x64';
if(!windows&&!(process.platform==='darwin'&&process.arch==='arm64'))throw new Error('Supported engine targets: darwin-arm64, win32-x64');
const root=resolve(import.meta.dirname,'..'),dir=join(root,'.runtime/whisper-build'),version='1.9.5',sha='ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720';await mkdir(dir,{recursive:true});
const tar=join(dir,'source.tar.gz');let bytes;try{bytes=await readFile(tar);}catch{const r=await fetch(`https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${version}.tar.gz`);if(!r.ok)throw new Error('Source download failed');bytes=Buffer.from(await r.arrayBuffer());await writeFile(tar,bytes);}
if(createHash('sha256').update(bytes).digest('hex')!==sha)throw new Error('Source checksum mismatch');execFileSync('tar',['-xzf',tar,'-C',dir]);const source=join(dir,`whisper.cpp-${version}`),file=join(source,'examples/server/server.cpp');let cpp=await readFile(file,'utf8');const anchor='std::unique_ptr<httplib::Server> svr = std::make_unique<httplib::Server>();';if(!cpp.includes(anchor))throw new Error('Engine patch anchor changed');cpp=cpp.replace(anchor,anchor+`
    const char * token_env = std::getenv("BOTIN_WHISPER_TOKEN");
    if (!token_env || std::string(token_env).size() < 32) { return 2; }
    const std::string botin_auth = std::string("Bearer ") + token_env;
    svr->set_payload_max_length(4000000);
    svr->new_task_queue = [] { return new httplib::ThreadPool(1); };
    svr->set_pre_routing_handler([botin_auth](const Request &req, Response &res) {
        if (req.get_header_value("Authorization") != botin_auth) {
            res.status = 401; res.set_content("Unauthorized", "text/plain");
            return httplib::Server::HandlerResponse::Handled;
        }
        if (!((req.method == "POST" && req.path == "/inference") || (req.method == "GET" && req.path == "/health"))) {
            res.status = 404; res.set_content("Not found", "text/plain");
            return httplib::Server::HandlerResponse::Handled;
        }
        return httplib::Server::HandlerResponse::Unhandled;
    });
`);await writeFile(file,cpp);
const cmake=(args)=>windows?execFileSync(process.env.BOTIN_CMAKE||'cmake',args,{stdio:'inherit'}):execFileSync('uv',['tool','run','--from','cmake','cmake',...args],{stdio:'inherit'});
cmake(['-S',source,'-B',join(dir,'build'),'-DCMAKE_BUILD_TYPE=Release','-DBUILD_SHARED_LIBS=OFF',...windows?['-G','Visual Studio 17 2022','-A','x64','-DGGML_NATIVE=OFF','-DGGML_METAL=OFF','-DGGML_OPENMP=OFF','-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded']:['-DGGML_METAL=ON','-DGGML_METAL_EMBED_LIBRARY=ON',`-DCMAKE_C_FLAGS=-ffile-prefix-map=${source}=whisper.cpp`,`-DCMAKE_CXX_FLAGS=-ffile-prefix-map=${source}=whisper.cpp`],'-DWHISPER_BUILD_TESTS=OFF','-DWHISPER_BUILD_EXAMPLES=ON','-DWHISPER_CURL=OFF']);cmake(['--build',join(dir,'build'),'--config','Release','--target','whisper-server','-j','8']);
const binary=windows?'whisper-server.exe':'whisper-server';const out=join(root,`dashboard/resources/whisper/${process.platform}-${process.arch}`);await mkdir(out,{recursive:true});await copyFile(join(dir,windows?'build/bin/Release/whisper-server.exe':'build/bin/whisper-server'),join(out,binary));await chmod(join(out,binary),0o755);await copyFile(join(source,'LICENSE'),join(out,'LICENSE'));const engine=await readFile(join(out,binary));await writeFile(join(out,'manifest.json'),JSON.stringify({version,platform:process.platform,arch:process.arch,sourceSha256:sha,sha256:createHash('sha256').update(engine).digest('hex'),bytes:engine.length,patch:'botin-auth-inference-only-v1'},null,2));console.log('Bundled authenticated Whisper engine:',out);

// Re-sign with the release identity, then update ENGINE_SHA in dashboard/wake_assets.py.
