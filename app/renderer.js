const $=id=>document.getElementById(id);
let current,initialized=false,saving=false;
const phases={stopped:'Detenido',login:'Vincula WhatsApp',starting:'Conectando…',running:'Sincronizando',retrying:'Reintentando…',stopping:'Deteniendo…',logout:'Cerrando sesión…',error:'Necesita atención'};
const errors={
 USER_INVALID:'Introduce tu nombre de usuario de Last.fm.',
 KEY_REQUIRED:'Introduce tu API key de Last.fm para continuar.',
 KEY_INVALID:'La API key debe tener 32 caracteres hexadecimales.',
 IDLE_INVALID:'El mensaje de reposo debe tener entre 1 y 50 unidades de texto, sin saltos de línea.',
 LASTFM_API_10:'Last.fm rechazó la API key. Detén el servicio y revisa tus datos.',
 LASTFM_API_6:'Last.fm no reconoce el usuario o los parámetros. Revisa tus datos.',
 LASTFM_API_26:'Last.fm ha suspendido esta API key.',
 LOGIN_REQUIRED:'No se detectó la sesión. Cierra sesión y vuelve a vincular WhatsApp. La interfaz de WhatsApp Web debe estar en español.',
 UI_CHANGED:'Los controles de WhatsApp cambiaron. Usa WhatsApp Web en español; no se modificó otro campo.',
 UI_CHANGED_OR_SESSION_REQUIRED:'No se encontró el campo de perfil. Comprueba la sesión y que WhatsApp Web esté en español.',
 PROFILE_EDIT_UNAVAILABLE:'WhatsApp no mostró el editor de Info. Comprueba que el perfil permita editar el estado de texto.',
 LOGOUT_FAILED:'No se pudo confirmar el cierre de sesión. No se da por desvinculada. Puedes desvincular nowBubble desde WhatsApp → Dispositivos vinculados y volver a intentarlo.',
 CONNECTION_ERROR:'No se pudo conectar. Comprueba Internet y que Google Chrome esté instalado.',
 SETTINGS_INVALID:'No se pudo leer la configuración local.',
 TEXT_REJECTED:'WhatsApp rechazó el texto; se mantiene el último valor confirmado.',
 READBACK_FAILED:'No se pudo confirmar el texto publicado. Se volverá a comprobar.'
};
function explain(code){return errors[code]||'No hay respuesta válida del servicio. Se conserva el último texto y se reintentará.';}
function notice(text,error=false){$('notice').hidden=!text;$('notice').textContent=text||'';$('notice').classList.toggle('error',error);}
function count(){const n=$('idle').value.length;$('count').textContent=n+' / 50';$('count').classList.toggle('invalid',n>50||!$('idle').value.trim());$('saveIdle').disabled=n>50||!$('idle').value.trim()||saving;}
function render(state){
 current=state;
 $('status').textContent=phases[state.phase]||state.phase;$('status').classList.toggle('active',state.phase==='running');
 $('published').textContent=state.published===null?'Tu próxima canción empieza aquí.':state.published||'La burbuja está vacía.';
 $('confirmed').textContent=state.confirmedAt?'Última lectura confirmada · '+new Date(state.confirmedAt).toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'El texto aparecerá después de conectar WhatsApp.';
 if(!initialized){$('username').value=state.username;$('idle').value=state.idleText;initialized=true;count();}
 $('key').placeholder=state.hasApiKey?'Clave guardada · escribe para cambiarla':'Tu API key';
 $('linked').textContent=state.linked?'WhatsApp vinculado':'WhatsApp sin vincular';
 $('start').textContent=state.linked?'Iniciar sincronización':'Vincular e iniciar';
 $('start').disabled=state.busy||!state.hasApiKey;
 $('stop').disabled=!state.busy||['stopping','logout'].includes(state.phase);
 $('username').disabled=state.busy;$('key').disabled=state.busy;$('saveAccounts').disabled=state.busy;
 $('logout').disabled=['stopping','logout','login','starting'].includes(state.phase)||(!state.linked&&!state.busy);
 $('loginHelp').textContent=state.phase==='login'?'Escanea el QR en Chrome desde WhatsApp → Dispositivos vinculados. Tienes 5 minutos.':state.linked?'Al iniciar, Chrome funcionará en segundo plano.':'Se abrirá Chrome para vincular WhatsApp con un QR. Usa WhatsApp Web en español.';
 if(state.error)notice(explain(state.error),true);else if(state.phase==='running')notice('');
}
async function action(name,payload){
 try{const result=await window.wawiwe.action(name,payload);render(result.state);if(!result.ok)notice(explain(result.error),true);return result.ok;}
 catch{notice('No se pudo comunicar con el servicio local.',true);return false;}
}
$('accounts').addEventListener('submit',async e=>{e.preventDefault();$('saveAccounts').disabled=true;if(await action('credentials',{username:$('username').value,apiKey:$('key').value})){$('key').value='';notice('Datos guardados. Ya puedes iniciar.');}$('saveAccounts').disabled=current?.busy;});
$('start').addEventListener('click',()=>action('start'));
$('stop').addEventListener('click',()=>action('stop'));
$('idle').addEventListener('input',count);
$('idleForm').addEventListener('submit',async e=>{e.preventDefault();saving=true;count();if(await action('idle',{text:$('idle').value}))notice('Mensaje de reposo guardado.');saving=false;count();});
$('logout').addEventListener('click',()=>$('logoutDialog').showModal());
$('cancelLogout').addEventListener('click',()=>$('logoutDialog').close());
$('confirmLogout').addEventListener('click',()=>{$('logoutDialog').close();action('logout');});
window.wawiwe.onState(render);window.wawiwe.getState().then(render).catch(()=>notice('No se pudo abrir la aplicación.',true));

