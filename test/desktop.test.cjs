const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Settings}=require('../app/settings.cjs');const {Service,safeCode}=require('../app/service.cjs');
const wait=async(predicate)=>{const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)throw Error('test timeout');await new Promise(r=>setTimeout(r,15));}};
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'wawiwe-'));
test('vault protects credentials; public settings never expose key',async()=>{
 const dir=temp(),key='a'.repeat(32),vault={encrypt:async s=>Buffer.from(s).reverse(),decrypt:async b=>Buffer.from(b).reverse().toString()};
 const store=new Settings(dir,vault);await store.credentials('testuser',key);assert.equal(await store.secret(),key);assert.equal(store.public().apiKey,undefined);assert.ok(!fs.readFileSync(store.file,'utf8').includes(key));await store.credentials('other','');assert.equal(await store.secret(),key);assert.equal(new Settings(dir,vault).data.username,'other');
});
test('idle settings reject overflow, empty and newlines; persist Unicode',()=>{
 const dir=temp(),store=new Settings(dir,{});for(const value of ['', '   ','x'.repeat(51),'x\ny','🎵'.repeat(26)])assert.throws(()=>store.idle(value),/IDLE_INVALID/);store.idle('Descansando 🎵');assert.equal(new Settings(dir,{}).public().idleText,'Descansando 🎵');
});
test('idle edit invalidates pending write, preserves song and grace',async()=>{
 const {SyncState}=await import('../lib/core.mjs');const s=new SyncState({idleGraceMs:0,idleText:'Reposo'});
 s.accept(s.startRequest(0),{kind:'idle'},0);const old=s.next(0);s.setIdleText('Pausa 🎵');assert.equal(s.isCurrent(old,0),false);assert.equal(s.next(0).text,'Pausa 🎵');
 s.accept(s.startRequest(1),{kind:'playing',artist:'A',title:'B'},1);const song=s.next(1);s.setIdleText('Otro reposo');assert.equal(s.next(1).text,song.text);
});
function fake(){
 const settings={dir:'unused',data:{username:'test',idleText:'Reposo',linked:true},public(){return {username:'test',idleText:this.data.idleText,linked:this.data.linked,hasApiKey:true};},secret:async()=>'',idle(text){this.data.idleText=text;},linked(value){this.data.linked=value;}};
 let quits=0,writes=0,logout=0,read='existing',failLogout=false;
 const driver={findElements:async()=>[{}],quit:async()=>{quits++;},navigate:()=>({refresh:async()=>{}})};
 const ui={read:async()=>read,ensure:async text=>{writes++;read=text;return {text,changed:true};},logout:async()=>{logout++;if(failLogout)throw Error('offline');}};
 const service=new Service(settings,{openBrowser:async()=>driver,makeSource:async()=>({poll:async()=>({observation:{kind:'playing',artist:'A',title:'B'},nextDelayMs:30000})}),makeUI:()=>ui});
 return {service,settings,ui,get quits(){return quits;},get writes(){return writes;},get logout(){return logout;},set failLogout(v){failLogout=v;}};
}
test('published text is confirmed; stop retains session/settings',async()=>{
 const f=fake();f.service.start();await wait(()=>f.writes===1);assert.match(f.service.snapshot().published,/Now listening: A - B/);await f.service.stop();assert.equal(f.quits,1);assert.equal(f.settings.data.linked,true);assert.equal(f.service.snapshot().phase,'stopped');assert.equal(f.service.snapshot().busy,false);
});
test('double start has one task; idle can change during music',async()=>{
 const f=fake();f.service.start();const task=f.service.task;f.service.start();assert.equal(f.service.task,task);await wait(()=>f.writes===1);f.service.setIdle('Un descanso');assert.equal(f.settings.data.idleText,'Un descanso');await f.service.stop();
});
test('logout stops then confirms remote logout, retaining preferences',async()=>{
 const f=fake();f.service.start();await wait(()=>f.writes===1);await f.service.logout();assert.equal(f.logout,1);assert.equal(f.quits,2);assert.equal(f.settings.data.linked,false);assert.equal(f.settings.data.idleText,'Reposo');assert.equal(f.service.snapshot().published,null);
});
test('failed logout never claims session is gone',async()=>{
 const f=fake();f.failLogout=true;await assert.rejects(f.service.logout(),/LOGOUT_FAILED/);assert.equal(f.settings.data.linked,true);assert.equal(f.service.state.phase,'error');
});
test('stop prevents slow source result from writing',async()=>{
 const f=fake();let resolve;f.service.makeSource=async()=>({poll:()=>new Promise(r=>{resolve=r;})});f.service.start();await wait(()=>resolve);const stopped=f.service.stop();resolve({observation:{kind:'playing',artist:'A',title:'B'},nextDelayMs:30000});await stopped;assert.equal(f.writes,0);
});
test('UI errors never contain raw messages or credentials',()=>{
 assert.equal(safeCode(Error('https://example.invalid/?api_key=secret')),'CONNECTION_ERROR');assert.equal(safeCode({code:'LASTFM_API_10'}),'LASTFM_API_10');
});
