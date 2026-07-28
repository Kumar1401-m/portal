import puppeteer from 'puppeteer-core';
const CHROME='C:'+String.fromCharCode(92)+'Program Files'+String.fromCharCode(92)+'Google'+String.fromCharCode(92)+'Chrome'+String.fromCharCode(92)+'Application'+String.fromCharCode(92)+'chrome.exe';
const BASE='https://agency-next-tau.vercel.app';
const b=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox']});
const page=await b.newPage(); page.setDefaultTimeout(45000);
await page.goto(`${BASE}/login`,{waitUntil:'networkidle0'});
await page.type('input[name="email"]','nagavenkatakumar1401@gmail.com');
await page.type('input[name="password"]','@Venkat1401');
await Promise.all([page.click('button[type="submit"]'),page.waitForNavigation({waitUntil:'networkidle0'})]);
await page.goto(`${BASE}/deliverables/new`,{waitUntil:'networkidle0'});
const f=await page.evaluate(()=>({
  inputs:[...document.querySelectorAll('input,select,textarea')].map(e=>`${e.tagName.toLowerCase()}[${e.name}]${e.required?'*':''}${e.tagName==='SELECT'?' opts='+e.options.length:''}`),
}));
console.log(f.inputs.join('\n'));
await b.close();
