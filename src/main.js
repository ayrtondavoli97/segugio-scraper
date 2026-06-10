import{Actor}from'apify';
await Actor.init();
const url='https://www.ilportaleofferte.it/portaleOfferte/it/open-data.page';
const res=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'}});
const text=await res.text();
await Actor.pushData({source:'portale_offerte',url,status:res.status,ok:res.ok,title:(text.match(/<title>(.*?)<\/title>/i)||[])[1]||'',sample:text.replace(/<[^>]+>/g,' ').replace(/