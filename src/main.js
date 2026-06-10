import{Actor}from'apify';
await Actor.init();
const url='https://www.ilportaleofferte.it/portaleOfferte/it/open-data.page';
const res=await fetch(url);
const text=await res.text();
await Actor.pushData({source:'portale_offerte',url,status:res.status,ok:res.ok,bytes:text.length,sample:text.slice(0,1500)});
await Actor.exit();