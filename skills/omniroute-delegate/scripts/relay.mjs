#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const SCHEMA = "delegate-relay.result.v1";
const HELP = `Usage: node relay.mjs --brief <file> [options]
  --cd <dir>                 child working directory
  --out-dir <dir>            artifact directory
  --remote <url>             OmniRoute remote endpoint
  --api-key <key>            OmniRoute key (prefer OMNIROUTE_API_KEY)
  --token <token>             OmniRoute token
  --port <port>              local OmniRoute port
  --profile <name>           OmniRoute Claude profile
  --model <provider/model>   OmniRoute direct model (uses omniroute run claude)
  --lane <name>             resolve a delegate-setup fleet lane
  --timeout <h/m/s>          watchdog
  --resume-last              pass --continue to Claude
  --session <id>             pass --resume <id> to Claude
  --read-only                pass Claude plan mode and read-only tools
  --dangerously-skip-permissions  pass Claude bypass mode
  --help`;

function fail(message, code = 2) { console.error(`omniroute-relay: ${message}`); process.exit(code); }
function value(args, i, flag) { if (args[i + 1] === undefined) fail(`${flag} requires a value`); return args[i + 1]; }
function duration(s) { const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s); if (!m || !m.slice(1).some(Boolean)) return null; const n = (+m[1]||0)*3600000+(+m[2]||0)*60000+(+m[3]||0)*1000; return n > 0 && n <= 2147483647 ? n : null; }
function parse(argv) {
  const o = { lane:null, brief:null, cd:process.cwd(), outDir:null, remote:null, apiKey:null, token:null, port:null, profile:null, model:null, timeout:null, resumeLast:false, session:null, readOnly:false, dangerous:false };
  for (let i=0;i<argv.length;i++) { const a=argv[i]; switch(a) {
    case "--help": case "-h": console.log(HELP); process.exit(0);
    case "--lane": o.lane=value(argv,i++,a); break;
    case "--brief": o.brief=value(argv,i++,a); break; case "--cd": o.cd=resolve(value(argv,i++,a)); break;
    case "--out-dir": o.outDir=resolve(value(argv,i++,a)); break; case "--remote": o.remote=value(argv,i++,a); break;
    case "--api-key": o.apiKey=value(argv,i++,a); break; case "--token": o.token=value(argv,i++,a); break;
    case "--port": o.port=value(argv,i++,a); break; case "--profile": o.profile=value(argv,i++,a); break;
    case "--model": o.model=value(argv,i++,a); break; case "--timeout": o.timeout=value(argv,i++,a); break;
    case "--resume-last": o.resumeLast=true; break; case "--session": o.session=value(argv,i++,a); break;
    case "--read-only": o.readOnly=true; break; case "--dangerously-skip-permissions": o.dangerous=true; break;
    default: fail(`unknown option ${a}`);
  }}
  if (o.brief && !existsSync(o.brief)) fail("brief file not found: " + o.brief); if (!o.brief && process.stdin.isTTY) fail("pass --brief <file> or pipe the brief on stdin");
  if (!existsSync(o.cd)) fail(`--cd directory not found: ${o.cd}`);
  if (o.resumeLast && o.session) fail("--resume-last and --session are mutually exclusive");
  if (o.readOnly && o.dangerous) fail("--read-only and --dangerously-skip-permissions are mutually exclusive");
  if (o.timeout && !duration(o.timeout)) fail(`invalid --timeout ${o.timeout}`);
  return o;
}
function claudeArgs(o) {
  const a=["-p","--output-format","stream-json","--verbose"];
  if (o.readOnly) a.push("--permission-mode","plan","--tools","Read,Glob,Grep");
  else if (o.dangerous) a.push("--dangerously-skip-permissions");
  else a.push("--permission-mode","acceptEdits","--tools","Read,Glob,Grep,Edit,Write,Bash");
  if (o.resumeLast) a.push("--continue"); if (o.session) a.push("--resume",o.session); return a;
}
function launcher(o) {
  const a=[]; let command="omniroute";
  if (o.remote) a.push("--remote",o.remote); if (o.apiKey) a.push("--api-key",o.apiKey); if (o.token) a.push("--token",o.token); if (o.port) a.push("--port",o.port);
  if (o.model) { a.push("run","claude","--model",o.model,"--",...claudeArgs(o)); }
  else { a.push("launch"); if (o.profile) a.push("--profile",o.profile); a.push(...claudeArgs(o)); }
  return { command, args:a };
}
function applyLane(o) {
  if (!o.lane) return;
  const localSetup=join(dirname(fileURLToPath(import.meta.url)),"../../delegate-setup/scripts/lane.mjs");
  const sharedSetup=join(process.env.USERPROFILE||process.env.HOME||"", ".agents", "skills", "delegate-setup", "scripts", "lane.mjs");
  const setup=existsSync(localSetup)?localSetup:sharedSetup;
  if (!existsSync(setup)) fail("--lane requires the delegate-setup skill installed globally or beside this relay");
  const r=spawnSync(process.execPath,[setup,"resolve","--cwd",o.cd,"--lane",o.lane,"--implementer","omniroute"],{encoding:"utf8"});
  if (r.error || r.status !== 0) fail((r.stderr || "lane resolve failed").trim());
  let resolved; try { const lines=(r.stdout||"").trim().split(/\r?\n/).filter(Boolean); resolved=JSON.parse(lines[lines.length-1]); } catch { fail("lane resolve returned invalid JSON"); }
  const d=resolved.dials||{};
  if (o.model===null && d.model!==undefined) o.model=d.model;
  if (o.timeout===null && d.timeout!==undefined) o.timeout=d.timeout;
  if (!o.readOnly && d.readOnly===true) o.readOnly=true;
}function main() {
  const o=parse(process.argv.slice(2)); applyLane(o); const brief=o.brief ? readFileSync(o.brief,"utf8") : readFileSync(0,"utf8");
  const out=o.outDir || join(tmpdir(),"delegate-relay",`${basename(o.cd)}-${Date.now()}-${process.pid}`); mkdirSync(out,{recursive:true});
  const paths={brief:join(out,"brief.txt"),events:join(out,"events.jsonl"),final:join(out,"final.txt"),stderr:join(out,"stderr.txt"),result:join(out,"result.json")};
  writeFileSync(paths.brief,brief); writeFileSync(paths.events,""); writeFileSync(paths.final,""); writeFileSync(paths.stderr,"");
  const spec=launcher(o); const startedAt=new Date().toISOString(); const env={...process.env}; delete env.CLAUDECODE;
  const child=spawn(spec.command,spec.args,{cwd:o.cd,env,stdio:["pipe","pipe","pipe"],windowsHide:true,shell:process.platform==="win32"});
  child.stdin.end(brief); let finalMessage="", plainMessage="", sessionId=null, timedOut=false; const started=Date.now();
  const consume=(chunk)=>{ appendFileSync(paths.events,chunk); for(const line of chunk.toString().split(/\r?\n/)){ if(!line.trim()) continue; try { const e=JSON.parse(line); sessionId=e.session_id||e.sessionId||sessionId; if(e.type==="result" && typeof e.result==="string") finalMessage=e.result; if(e.type==="assistant" && Array.isArray(e.message?.content)) finalMessage=e.message.content.filter(x=>x.type==="text").map(x=>x.text).join("\\n"); } catch { plainMessage += line + "\\n"; } }};
  child.stdout.on("data",consume); child.stderr.on("data",x=>appendFileSync(paths.stderr,x));
  const timer=o.timeout?setTimeout(()=>{timedOut=true; child.kill("SIGTERM");},duration(o.timeout)):null;
  child.on("close",(code,signal)=>{ if(timer) clearTimeout(timer); finalMessage = finalMessage || plainMessage.trim(); writeFileSync(paths.final,finalMessage); const status=timedOut?"timeout":(code===0?"completed":"failed"); const result={schema:SCHEMA,status,exitCode:timedOut?1:code,signal:signal||null,sessionId,finalMessage,touchedFiles:[],artifacts:paths,startedAt,finishedAt:new Date().toISOString(),omniroute:{command:spec.command,args:spec.args.map(x=>x.includes("key")?"[redacted]":x)}}; writeFileSync(paths.result,JSON.stringify(result,null,2)+"\n"); console.log(JSON.stringify(result,null,2)); process.exit(timedOut?1:(code??1)); });
}
main();
