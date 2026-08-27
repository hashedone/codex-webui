import { chromium } from 'playwright';
import { launchOptions } from './browser-runtime.mjs';

const base=process.env.CODEX_WEBUI_TEST_URL||'http://127.0.0.1:8899';
const browser=await chromium.launch(launchOptions());
const page=await browser.newPage({viewport:{width:1180,height:820},colorScheme:'dark'});

try {
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>globalThis.__codexWebuiDebug?.syncTurnSnapshot);
  const result=await page.evaluate(()=>{
    const api=globalThis.__codexWebuiDebug,{state}=api;
    for(const animation of state.motion.values())animation?.destroy?.();
    for(const key of ['items','turns','activities','activityItems','dividers','motion'])state[key].clear();
    document.querySelector('#conversation').replaceChildren();
    state.active={id:'reconcile-thread',cwd:state.config.defaultCwd,turns:[]};

    const text='Keep this repeated-looking user input as one logical message.';
    api.notify('item/completed',{
      threadId:'reconcile-thread',
      turnId:'reconcile-turn',
      item:{id:'01a-live-user',type:'userMessage',content:[{type:'text',text}]},
    });
    api.syncTurnSnapshot({
      id:'reconcile-turn',
      status:'completed',
      itemsView:'full',
      items:[{id:'item-1',type:'userMessage',content:[{type:'text',text}]}],
    },'reconcile-thread');

    const nodes=[...document.querySelectorAll('#conversation .user-turn')];
    return {
      count:nodes.length,
      text:nodes.map(node=>node.textContent.trim()),
      uniqueMappedNodes:new Set([
        state.items.get('01a-live-user'),
        state.items.get('item-1'),
      ]).size,
    };
  });

  console.log(JSON.stringify(result,null,2));
  if(result.count!==1||result.uniqueMappedNodes!==1||result.text[0]!=='Keep this repeated-looking user input as one logical message.')process.exitCode=1;
} finally {
  await browser.close();
}
