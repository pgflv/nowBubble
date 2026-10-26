const fs=require('node:fs');
const path=require('node:path');
const DEFAULT_IDLE='No music, just thoughts';
function validateIdle(text) {
 if(typeof text!=='string'||!text.trim()||text.length>50||/[\r\n]/.test(text))throw Error('IDLE_INVALID');
 return text;
}
class Settings {
 constructor(directory,vault) {
  this.dir=directory;this.vault=vault;this.file=path.join(directory,'settings.json');
  this.data={username:'',encryptedKey:'',idleText:DEFAULT_IDLE,linked:false};
  if(fs.existsSync(this.file)) {
   try{this.data={...this.data,...JSON.parse(fs.readFileSync(this.file,'utf8'))};validateIdle(this.data.idleText);}
   catch{throw Error('SETTINGS_INVALID');}
  }
 }
 public(){return {username:this.data.username,hasApiKey:!!this.data.encryptedKey,idleText:this.data.idleText,linked:this.data.linked};}
 save(){fs.mkdirSync(this.dir,{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data));fs.renameSync(this.file+'.tmp',this.file);}
 async credentials(username,key) {
  if(typeof username!=='string'||!username.trim()||username.length>100)throw Error('USER_INVALID');
  if(typeof key!=='string'||(key&&!/^[a-f0-9]{32}$/i.test(key.trim())))throw Error('KEY_INVALID');
  if(!key&&!this.data.encryptedKey)throw Error('KEY_REQUIRED');
  if(key)this.data.encryptedKey=(await this.vault.encrypt(key.trim())).toString('base64');
  this.data.username=username.trim();this.save();
 }
 async secret(){if(!this.data.encryptedKey)throw Error('KEY_REQUIRED');return this.vault.decrypt(Buffer.from(this.data.encryptedKey,'base64'));}
 idle(text){this.data.idleText=validateIdle(text);this.save();}
 linked(value){this.data.linked=value;this.save();}
}
module.exports={Settings,validateIdle,DEFAULT_IDLE};

