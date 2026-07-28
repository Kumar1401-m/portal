import puppeteer from 'puppeteer-core';
const CHROME='C:'+String.fromCharCode(92)+'Program Files'+String.fromCharCode(92)+'Google'+String.fromCharCode(92)+'Chrome'+String.fromCharCode(92)+'Application'+String.fromCharCode(92)+'chrome.exe';
const BASE='https://agency-next-tau.vercel.app';
const FILE=process.env.TEST_FILE;
const b=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox']});
const page=await b.newPage(); page.setDefaultTimeout(45000);
await page.setViewport({width:1500,height:1200});
const netFails=[]; const consoleErrs=[];
page.on('requestfailed',r=>{ if(r.url().includes('r2.cloudflarestorage.com')) netFails.push(`${r.method()} ${r.failure()?.errorText}`); });
page.on('console',m=>{ if(m.type()==='error') consoleErrs.push(m.text().slice(0,180)); });
page.on('response',r=>{ if(r.url().includes('r2.cloudflarestorage.com')) console.log('   R2 response:',r.request().method(),r.status()); });

await page.goto(`${BASE}/login`,{waitUntil:'networkidle0'});
await page.type('input[name="email"]','nagavenkatakumar1401@gmail.com');
await page.type('input[name="password"]','@Venkat1401');
await Promise.all([page.click('button[type="submit"]'),page.waitForNavigation({waitUntil:'networkidle0'})]);

// Make a task to upload against.
await page.goto(`${BASE}/deliverables/new`,{waitUntil:'networkidle0'});
await page.evaluate(()=>{
  const iSet=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  const sSet=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
  const setSel=(name)=>{ const el=document.querySelector('select[name="'+name+'"]'); if(!el) return; const opt=[...el.options].find(o=>o.value); if(opt){ sSet.call(el,opt.value); el.dispatchEvent(new Event('change',{bubbles:true})); } };
  const t=document.querySelector('input[name="title"]'); iSet.call(t,'ZZTEST Upload Probe'); t.dispatchEvent(new Event('input',{bubbles:true}));
  setSel('service'); setSel('client_id');
});
await new Promise(r=>setTimeout(r,1200));
await page.evaluate(()=>{
  const sSet=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
  const el=document.querySelector('select[name="content_category"]');
  const opt=[...el.options].find(o=>o.value); if(opt){ sSet.call(el,opt.value); el.dispatchEvent(new Event('change',{bubbles:true})); }
});
await Promise.all([
  page.evaluate(()=>document.querySelector('form button[type="submit"]').click()),
  page.waitForNavigation({waitUntil:'networkidle0'}).catch(()=>{}),
]);
console.log('after create ->', page.url());

await page.goto(`${BASE}/deliverables`,{waitUntil:'networkidle0'});
let open=false;
for(let i=0;i<15&&!open;i++){
  await page.evaluate(()=>{const rows=[...document.querySelectorAll('tr')];const r=rows.find(x=>x.innerText.includes('ZZTEST Upload Probe'));const btn=r&&r.querySelector('button[aria-label^="Update"]');if(btn)btn.click();});
  await new Promise(r=>setTimeout(r,500));
  open=await page.evaluate(()=>!!document.querySelector('input[type="file"][accept="video/*"]'));
}
console.log('modal with upload field open:',open);
if(open){
  const input=await page.$('input[type="file"][accept="video/*"]');
  await input.uploadFile(FILE);
  await new Promise(r=>setTimeout(r,15000));
  const state=await page.evaluate(()=>{
    const p=document.querySelector('.animate-pop-in');
    return { text: p.innerText.replace(/\s+/g,' ').slice(0,400) };
  });
  console.log('modal state:',state.text);
}
console.log('R2 request failures:',netFails.length?netFails.join(' | '):'(none)');
console.log('console errors:',consoleErrs.length?consoleErrs.slice(0,3).join(' | '):'(none)');
await b.close();
