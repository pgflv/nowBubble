const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('wawiwe',{
 getState:()=>ipcRenderer.invoke('state'),
 action:(name,payload)=>ipcRenderer.invoke('action',name,payload),
 onState:callback=>{const listener=(_,state)=>callback(state);ipcRenderer.on('state',listener);return()=>ipcRenderer.removeListener('state',listener);}
});

