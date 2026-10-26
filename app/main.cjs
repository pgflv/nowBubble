const {app,BrowserWindow,ipcMain,safeStorage,Menu}=require('electron');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {Settings}=require('./settings.cjs');
const {Service,safeCode}=require('./service.cjs');
if(process.env.WAWIWE_HOME)app.setPath('userData',path.resolve(process.env.WAWIWE_HOME));
if(!app.requestSingleInstanceLock()){app.quit();}else{
 let win,service,settings,quitting=false,closing=false;
 app.on('second-instance',()=>{if(win){win.restore();win.show();win.focus();}});
 app.whenReady().then(async()=>{
  if(app.isPackaged)process.env.SE_MANAGER_PATH=path.join(process.resourcesPath,'app.asar.unpacked','node_modules','selenium-webdriver','bin','windows','selenium-manager.exe');
  const vault={
   async encrypt(text){if(!await safeStorage.isAsyncEncryptionAvailable())throw Error('ENCRYPTION_UNAVAILABLE');return safeStorage.encryptStringAsync(text);},
   async decrypt(buffer){return (await safeStorage.decryptStringAsync(buffer)).result;}
  };
  settings=new Settings(app.getPath('userData'),vault);service=new Service(settings);
  Menu.setApplicationMenu(null);
  win=new BrowserWindow({width:780,height:850,minWidth:680,minHeight:760,show:false,title:'nowBubble',icon:path.join(__dirname,'icon.ico'),backgroundColor:'#101a18',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  const url=pathToFileURL(path.join(__dirname,'index.html')).href;
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,to)=>{if(to!==url)event.preventDefault();});
  win.webContents.session.setPermissionRequestHandler((_,__,callback)=>callback(false));
  const check=event=>{if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw Error('FORBIDDEN');};
  ipcMain.handle('state',event=>{check(event);return service.snapshot();});
  ipcMain.handle('action',async(event,action,payload)=>{
   check(event);
   try{
    if(action==='credentials'){if(service.task||service.logoutTask)throw Error('BUSY');await settings.credentials(payload?.username,payload?.apiKey);service.emit('state',service.snapshot());}
    else if(action==='idle'){service.setIdle(payload?.text);}
    else if(action==='start'){if(!settings.data.username||!settings.data.encryptedKey)throw Error('KEY_REQUIRED');service.start();}
    else if(action==='stop'){await service.stop();}
    else if(action==='logout'){await service.logout();}
    else throw Error('FORBIDDEN');
    return {ok:true,state:service.snapshot()};
   }catch(error){return {ok:false,error:safeCode(error),state:service.snapshot()};}
  });
  service.on('state',state=>{if(!win.isDestroyed())win.webContents.send('state',state);});
  win.on('close',event=>{
   if(!quitting){event.preventDefault();if(closing)return;closing=true;service.update({phase:'stopping'});Promise.resolve(service.logoutTask).catch(()=>{}).then(()=>service.stop()).finally(()=>{quitting=true;app.quit();});}
  });
  app.on('before-quit',event=>{if(!quitting){event.preventDefault();win.close();}});
  await win.loadFile(path.join(__dirname,'index.html'));win.show();
 }).catch(()=>{require('electron').dialog.showErrorBox('nowBubble','No se pudo abrir la configuración local o el almacenamiento seguro.');app.quit();});
}

