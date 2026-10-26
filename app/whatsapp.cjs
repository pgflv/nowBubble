const { Builder, By, Key } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const path = require('node:path');
class ProfileUI {
  constructor(driver) { this.driver=driver; }
  async one(selector) {
    let previous='';
    try { return await this.driver.wait(async()=>{
      const all=await this.driver.findElements(By.css(selector));
      const visible=[];for(const item of all){try{if(await item.isDisplayed())visible.push(item);}catch{previous='';return false;}}
      if(visible.length>1)throw Error('AMBIGUOUS');
      if(visible.length!==1){previous='';return false;}
      const rect=JSON.stringify(await visible[0].getRect());
      if(rect!==previous){previous=rect;return false;}
      return visible[0];
    },8000); } catch { const e=Error('UI_CHANGED_OR_SESSION_REQUIRED');e.selector=selector;throw e; }
  }
  async editor() {
    const d=this.driver;
    await this.dismissNotice();
    let fields=await d.findElements(By.css('[data-testid="popup-contents"] input[role="textbox"]'));
    if(!fields.length) {
      let edit=await d.findElements(By.css('button[aria-label="Botón de editar para la creación de estados de texto"]'));
      if(!edit.length) {
        let profile=await d.findElements(By.css('button[aria-label="Ver perfil"]'));
        if(!profile.length) {
          await (await this.one('button[aria-label="Tú"]')).click();
          await d.wait(async()=> (await d.findElements(By.css('button[aria-label="Ver perfil"]'))).length===1,10000);
        }
        await (await this.one('button[aria-label="Ver perfil"]')).click();
      }
      await (await this.one('button[aria-label="Botón de editar para la creación de estados de texto"]')).click();
      await d.wait(async()=> (await d.findElements(By.css('[data-testid="popup-contents"] input[role="textbox"]'))).length===1,10000)
        .catch(()=>{throw Error('PROFILE_EDIT_UNAVAILABLE');});
    }
    const panel=await this.one('[data-testid="popup-contents"]');
    const text=await panel.getText();
    // Only this observed profile popup: never a chat composer or multimedia Status.
    if(!text.startsWith('Info.')||!text.includes('Duración')||!/\d+\/50/.test(text))throw Error('UI_CHANGED');
    return this.one('[data-testid="popup-contents"] input[role="textbox"]');
  }
  async close() { await (await this.one('[data-testid="popup-contents"] button[aria-label="Cerrar"]')).click(); await this.driver.wait(async()=> (await this.driver.findElements(By.css('[data-testid="popup-contents"] input[role="textbox"]'))).length===0,10000); }
  async dismissNotice() {
    const d=this.driver;
    for(const dialog of await d.findElements(By.css('[role="dialog"]'))) {
      const id=await dialog.getAttribute('aria-labelledby');
      if(!id)continue;
      const titles=await d.findElements(By.id(id));
      if(titles.length!==1||(await titles[0].getText())!=='Novedades en WhatsApp Web')continue;
      const buttons=await dialog.findElements(By.xpath(".//*[self::button or @role='button'][normalize-space(.)='Continuar']"));
      if(buttons.length!==1)throw Error('UI_CHANGED');
      await buttons[0].click();
      await d.wait(async()=>{try{return !await dialog.isDisplayed();}catch{return true;}},8000);
    }
  }
  async logout() {
    const d=this.driver;
    const qr=async()=> (await d.findElements(By.css('[data-ref]'))).length>0;
    await d.wait(async()=>await qr()||(await d.findElements(By.css('button[aria-label="Tú"]'))).length>0,60000);
    if(await qr())return;
    await this.dismissNotice();
    await (await this.one('button[aria-label="Menú"]')).click();
    const item=await this.one('button[role="menuitem"][aria-label="Cerrar sesión"]');
    await item.click();
    // Confirm only an explicit logout button, never a generic Enter or chat control.
    await d.wait(async()=>{
      if(await qr())return true;
      const buttons=await d.findElements(By.xpath("//button[normalize-space(.)='Cerrar sesión']"));
      const visible=[];for(const b of buttons)if(await b.isDisplayed())visible.push(b);
      if(visible.length===1){await visible[0].click();return true;}
      return false;
    },10000);
    await d.wait(qr,30000);
  }
  async read() { const input=await this.editor(); const text=await input.getAttribute('value'); await this.close(); return text; }
  async ensure(text, stillCurrent=()=>true) {
    const input=await this.editor();
    const before=await input.getAttribute('value');
    if(before===text){await this.close();return {changed:false,text};}
    await input.sendKeys(Key.chord(Key.CONTROL,'a'),Key.BACK_SPACE);
    // CDP native text input supports non-BMP emojis that ChromeDriver sendKeys rejects.
    await this.driver.sendDevToolsCommand('Input.insertText',{text});
    if(await input.getAttribute('value')!==text)throw Error('TEXT_REJECTED');
    const button=await this.one('[data-testid="popup-contents"] button[aria-label="Guardar"]');
    if(!await button.isEnabled()||await input.getAttribute('aria-invalid')==='true')throw Error('TEXT_REJECTED');
    if(!stillCurrent()){await this.close();throw Error('STALE');}
    await button.click();
    await this.driver.wait(async()=> (await this.driver.findElements(By.css('[data-testid="popup-contents"] input[role="textbox"]'))).length===0,10000);
    const confirmed=await (await this.editor()).getAttribute('value');
    await this.close();
    if(confirmed!==text)throw Error('READBACK_FAILED');
    return {changed:true,text:confirmed};
  }
}
async function browser(c, visible) {
  const options=new chrome.Options().addArguments('--user-data-dir='+path.resolve(c.profile),'--window-size=1280,900');
  if(!visible)options.addArguments('--headless=new');
  const driver=await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  try { await driver.manage().setTimeouts({pageLoad:45000,script:10000,implicit:0}); await driver.get('https://web.whatsapp.com'); return driver; } catch(e) { await driver.quit().catch(()=>{}); throw e; }
}

module.exports={ProfileUI,browser};
