import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const npx=process.platform==='win32'?'npx.cmd':'npx';
const wrangler=['--yes','wrangler@4.92.0'];
function call(args,capture=false){
 const result=spawnSync(npx,[...wrangler,...args],{cwd:root,stdio:capture?['inherit','pipe','inherit']:'inherit',encoding:'utf8',shell:process.platform==='win32'});
 if(result.error)throw new Error(result.error.message);
 if(result.status!==0)throw new Error(`Wrangler ${args.slice(0,2).join(' ')} failed. Stop here and inspect the message above.`);
 return result.stdout||'';
}
function databases(){
 const output=call(['d1','list','--json'],true);
 try{const list=JSON.parse(output);if(!Array.isArray(list))throw new Error();return list;}
 catch{throw new Error('Could not read D1 list JSON. No configuration was changed.');}
}
if(process.argv.includes('--plan')){
 console.log('Plan: Cloudflare login -> find/create reflex-lab-db -> write real DB UUID -> migrate -> deploy. No commands executed.');
 process.exit(0);
}
try{
 console.log('Step 1/4: Sign in to your Cloudflare account in the browser.');
 call(['login']);
 console.log('Step 2/4: Find or create the project database.');
 let db=databases().find(x=>x.name==='reflex-lab-db');
 if(!db){call(['d1','create','reflex-lab-db']);db=databases().find(x=>x.name==='reflex-lab-db');}
 if(!db||!/^[0-9a-f-]{36}$/i.test(db.uuid))throw new Error('No valid database UUID was returned.');
 const config=join(root,'wrangler.toml');
 const original=readFileSync(config,'utf8');
 const replacement=original.replace(/database_id\s*=\s*"[^"]*"/,`database_id = "${db.uuid}"`);
 if(original===replacement&&!original.includes(db.uuid))throw new Error('Database binding could not be updated.');
 writeFileSync(config,replacement,'utf8');
 console.log('Step 3/4: Apply database migrations. Confirm the prompt if requested.');
 call(['d1','migrations','apply','DB','--remote']);
 console.log('Step 4/4: Deploy. Keep the Workers URL printed below.');
 call(['deploy']);
 console.log('Next: test the public URL, then commit wrangler.toml and push. GitHub auto-deployment still requires repository secrets.');
}catch(error){console.error(error.message);process.exitCode=1;}
