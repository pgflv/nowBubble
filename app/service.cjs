const path=require('node:path');
const {EventEmitter}=require('node:events');
const {By}=require('selenium-webdriver');
const {ProfileUI,browser}=require('./whatsapp.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class Service extends EventEmitter {
 constructor(settings,{openBrowser=browser,makeSource=null,makeUI=d=>new ProfileUI(d),now=Date.now}={}) {
  super();this.settings=settings;this.openBrowser=openBrowser;this.makeSource=makeSource;this.makeUI=makeUI;this.now=now;
  this.active=false;this.task=null;this.driver=null;this.engine=null;this.logoutTask=null;
  this.state={phase:'stopped',published:null,confirmedAt:null,error:null};
 }
 snapshot(){return {...this.state,...this.settings.public(),busy:!!this.task||!!this.logoutTask};}
 update(fields){Object.assign(this.state,fields);this.emit('state',this.snapshot());}
 async ready(driver,ms) {
  const end=this.now()+ms;
  while(this.active&&this.now()<end){
   if((await driver.findElements(By.css('button[aria-label="Tú"]'))).length)return;
   await sleep(500);
  }
  throw Error(this.active?'LOGIN_REQUIRED':'CANCELLED');
 }
 start() {
  if(this.task||this.logoutTask)return;
  this.active=true;
  this.task=this.run().catch(error=>{
   console.error('nowBubble:',error.name||'Error',safeCode(error),error.selector||'');
   if(this.active)this.update({phase:'error',error:safeCode(error)});
  }).finally(()=>{this.active=false;this.task=null;this.emit('state',this.snapshot());});
  this.emit('state',this.snapshot());
 }
 async run() {
  const {SyncState}=await import('../lib/core.mjs');
  const {LastfmClient}=await import('../lib/lastfm.mjs');
  const source=this.makeSource?await this.makeSource():new LastfmClient({username:this.settings.data.username,apiKey:await this.settings.secret(),maxResponseAgeMs:120000});
  this.engine=new SyncState({idleText:this.settings.data.idleText,lengthUnit:'utf16',maxLength:50,maxObservationAgeMs:120000});
  try {
   const needsLogin=!this.settings.data.linked;
   this.update({phase:needsLogin?'login':'starting',error:null});
   this.driver=await this.openBrowser({profile:path.join(this.settings.dir,'browser')},needsLogin);
   await this.ready(this.driver,needsLogin?300000:60000);
   if(!this.active)return;
   this.settings.linked(true);
   if(needsLogin) {
    this.update({phase:'starting'});
    await this.driver.quit();this.driver=null;
    if(!this.active)return;
    this.driver=await this.openBrowser({profile:path.join(this.settings.dir,'browser')},false);
    await this.ready(this.driver,60000);
   }
   const ui=this.makeUI(this.driver);
   const initial=await ui.read();
   this.update({phase:'running',published:initial,confirmedAt:this.now(),error:null});
   let nextPoll=0,nextUI=0,failures=0,uiFailures=0,lastCheck=0;
   while(this.active) {
    if(this.now()>=nextPoll) {
     const req=this.engine.startRequest(this.now());
     try {
      const result=await source.poll();
      this.engine.accept(req,result.observation,this.now());failures=0;
      nextPoll=this.now()+result.nextDelayMs;
      this.update({phase:'running',error:null});
     } catch(error) {
      this.engine.fail(req,this.now());
      this.update({phase:error.permanent?'error':'retrying',error:safeCode(error)});
      if(error.permanent)return;
      nextPoll=this.now()+Math.max(30000,Math.min(300000,5000*2**Math.min(++failures,6)),error.retryAfterMs||0);
     }
    }
    const candidate=this.engine.next(this.now(),{force:this.now()-lastCheck>=30000});
    if(candidate&&this.active&&this.now()>=nextUI) {
     try {
      const result=await ui.ensure(candidate.text,()=>this.active&&this.engine.isCurrent(candidate,this.now()));
      this.engine.acknowledge(candidate,this.now());lastCheck=this.now();uiFailures=0;
      this.update({phase:'running',error:null,published:result.text,confirmedAt:this.now()});
     } catch(error) {
      if(error.message!=='STALE'){
       this.update({phase:'retrying',error:safeCode(error)});
       nextUI=this.now()+Math.min(300000,5000*2**Math.min(++uiFailures,6));
      }
      await this.driver.navigate().refresh().catch(()=>{});
     }
    }
    await sleep(300);
   }
  } finally {
   if(this.driver){await this.driver.quit().catch(()=>{});this.driver=null;}
   this.engine=null;
  }
 }
 setIdle(text){
  this.settings.idle(text);this.engine?.setIdleText(text);this.emit('state',this.snapshot());
 }
 async stop() {
  this.active=false;
  if(this.task)this.update({phase:'stopping'});
  await this.task;
  this.update({phase:'stopped',error:null});
 }
 async logout() {
  if(this.logoutTask)return this.logoutTask;
  // Reserve the operation before awaiting stop: another start cannot race logout.
  this.logoutTask=this.doLogout().finally(()=>{this.logoutTask=null;this.emit('state',this.snapshot());});
  this.emit('state',this.snapshot());return this.logoutTask;
 }
 async doLogout(){
  await this.stop();this.update({phase:'logout',error:null});
  let driver;
  try{
   driver=await this.openBrowser({profile:path.join(this.settings.dir,'browser')},true);
   const ui=this.makeUI(driver);
   await ui.logout();
   this.settings.linked(false);
   this.update({phase:'stopped',published:null,confirmedAt:null,error:null});
  }catch(e){this.update({phase:'error',error:'LOGOUT_FAILED'});throw Error('LOGOUT_FAILED');}
  finally{if(driver)await driver.quit().catch(()=>{});}
 }
}
function safeCode(error){
 const c=error?.code||error?.message;
 return typeof c==='string'&&/^(LASTFM_[A-Z0-9_]+|LOGIN_REQUIRED|UI_CHANGED|UI_CHANGED_OR_SESSION_REQUIRED|PROFILE_EDIT_UNAVAILABLE|TEXT_REJECTED|READBACK_FAILED|KEY_REQUIRED|KEY_INVALID|USER_INVALID|IDLE_INVALID|SETTINGS_INVALID|LOGOUT_FAILED|CANCELLED)$/.test(c)?c:'CONNECTION_ERROR';
}
module.exports={Service,safeCode};

