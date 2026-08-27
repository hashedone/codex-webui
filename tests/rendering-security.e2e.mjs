import { createServer } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { launchOptions } from './browser-runtime.mjs';

const root=new URL('..',import.meta.url).pathname;
const freePort=()=>new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const address=probe.address();if(!address||typeof address==='string')return reject(new Error('Could not allocate renderer test port'));probe.close(error=>error?reject(error):resolve(address.port))})});
const waitFor=async(check,timeout=20_000)=>{const started=Date.now();while(Date.now()-started<timeout){try{if(await check())return}catch{}await Bun.sleep(50)}throw new Error('Timed out waiting for renderer test server')};

const port=await freePort(),base=`http://127.0.0.1:${port}`;
const fakeBinDir=mkdtempSync(join(tmpdir(),'codex-webui-renderer-bin-'));
const fakeCodex=join(fakeBinDir,'codex');
writeFileSync(fakeCodex,`#!/bin/sh\nexec bun ${JSON.stringify(join(root,'tests','fixtures','fake-codex-app-server.ts'))} "$@"\n`);
chmodSync(fakeCodex,0o755);
const server=Bun.spawn(['bun','run','server.ts'],{cwd:root,env:{...process.env,PATH:`${fakeBinDir}:${process.env.PATH}`,HOST:'127.0.0.1',PORT:String(port)},stdout:'ignore',stderr:'ignore'});
let browser;
try{
  await waitFor(async()=>(await fetch(`${base}/api/health`)).ok);
  browser=await chromium.launch(launchOptions());
  const page=await browser.newPage();
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>typeof globalThis.__renderAssistantMarkdown==='function');
  const result=await page.evaluate(()=>{
    document.body.dataset.pwned='0';
    const fixture=document.createElement('div');
    fixture.innerHTML=globalThis.__renderAssistantMarkdown('<a id="entity" href="javas&#99;ript:document.body.dataset.pwned=1">entity</a> <a id="numeric" href="java&#x73;cript:document.body.dataset.pwned=2">numeric</a> <a id="safe" href="https://example.com/docs">safe</a>');
    document.body.append(fixture);
    fixture.querySelector('#entity')?.click();
    fixture.querySelector('#numeric')?.click();
    const safe=[...fixture.querySelectorAll('a')].find(link=>link.textContent==='safe');
    return {pwned:document.body.dataset.pwned,entity:fixture.querySelector('#entity')?.getAttribute('href')??null,numeric:fixture.querySelector('#numeric')?.getAttribute('href')??null,safe:safe?.getAttribute('href')??null};
  });
  console.log(JSON.stringify(result));
  if(result.pwned!=='0'||result.entity!==null||result.numeric!==null||result.safe!=='https://example.com/docs')process.exitCode=1;
}finally{
  await browser?.close();
  server.kill();
  await server.exited;
  rmSync(fakeBinDir,{recursive:true,force:true});
}
