import puppeteer from 'puppeteer-core';
const CHROME='C:'+String.fromCharCode(92)+'Program Files'+String.fromCharCode(92)+'Google'+String.fromCharCode(92)+'Chrome'+String.fromCharCode(92)+'Application'+String.fromCharCode(92)+'chrome.exe';
const BASE='https://agency-next-tau.vercel.app';
const b=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox']});
const page=await b.newPage(); page.setDefaultTimeout(45000);
await page.setViewport({width:1500,height:1200});
await page.goto(`${BASE}/login`,{waitUntil:'networkidle0'});
await page.type('input[name="email"]','nagavenkatakumar1401@gmail.com');
await page.type('input[name="password"]','@Venkat1401');
await Promise.all([page.click('button[type="submit"]'),page.waitForNavigation({waitUntil:'networkidle0'})]);

await page.goto(`${BASE}/deliverables`,{waitUntil:'networkidle0'});
const row=await page.evaluate(()=>{
  const r=[...document.querySelectorAll('tr')].find(x=>x.innerText.includes('ZZTEST Upload Probe'));
  if(!r) return null;
  const link=[...r.querySelectorAll('a')].map(a=>a.getAttribute('href')).find(h=>h&&h.includes('r2.cloudflarestorage'));
  return { text:r.innerText.replace(/\s+/g,' | '), editorLink: link||null };
});
console.log('task row:', row ? row.text : '(not found)');
console.log('editor link is R2:', row?.editorLink ? 'yes' : 'no');

// Reopen the modal to read back the stored video link.
let stored=null;
for(let i=0;i<12&&!stored;i++){
  await page.evaluate(()=>{const rows=[...document.querySelectorAll('tr')];const r=rows.find(x=>x.innerText.includes('ZZTEST Upload Probe'));const btn=r&&r.querySelector('button[aria-label^="Update"]');if(btn)btn.click();});
  await new Promise(r=>setTimeout(r,600));
  stored=await page.evaluate(()=>{const el=document.querySelector('input[name="edited_link"]');return el?el.value:null;});
}
console.log('stored deliverable link:', stored ? stored.slice(0,110)+'…' : '(none)');
await b.close();
