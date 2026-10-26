# nowBubble

Una ventana para mostrar tu música de Last.fm en la burbuja de Info. de WhatsApp.

## Usar

1. Abre **nowBubble-1.1.0-Windows-x64.exe**. No necesitas instalar Node.js.
2. Introduce tu usuario y API key de Last.fm y pulsa **Guardar datos**.
3. Pulsa **Vincular e iniciar**. Se abre Chrome para escanear el QR desde WhatsApp → Dispositivos vinculados.
4. La ventana muestra el último texto leído y confirmado en tu perfil.
5. Cambia el mensaje de reposo y pulsa **Guardar** cuando quieras.

**Detener** conserva la sesión. **Cerrar sesión de WhatsApp** detiene, desvincula y conserva tus ajustes. Cerrar la ventana detiene la aplicación.

Requisitos: Windows x64 y Google Chrome instalado. WhatsApp Web debe estar en español: los controles se validaron en ese idioma. La primera conexión puede descargar el controlador de Chrome. El ejecutable no tiene firma de un editor comercial.

## Comportamiento y privacidad

Formato: **♬ Now listening: artista - canción**. Consulta Last.fm cada 30 segundos y usa el reposo tras 90 segundos de respuestas válidas sin reproducción. Un fallo de red no equivale a silencio. Solo guarda cambios y relee el valor guardado. Respeta 50 unidades UTF-16 sin partir emojis.

La duración depende de WhatsApp (se observó 1 día). Compara el campo para reponerlo si desaparece; puede haber intervalos vacíos al caducar. No lee conversaciones ni envía mensajes. Es automatización de WhatsApp Web, no una API oficial: cambios de interfaz pueden necesitar ajustes.

La clave se cifra con Windows DPAPI. Configuración y perfil se guardan en los datos de la aplicación, fuera del código y del ejecutable. No compartas esa carpeta.

## Código y compilación

```sh
npm ci
npm test
npm start
npm run dist
```

El ejecutable se genera en **dist/**. El workflow de GitHub permite construirlo manualmente o al subir una etiqueta v*. Queda disponible en Actions; no publica una release automáticamente.

El repositorio y el ejecutable no contienen claves, usuarios ni sesiones preconfiguradas. No se ha elegido una licencia abierta: el titular puede añadir la que prefiera antes de publicarlo.

Fuentes: [Last.fm](https://www.last.fm/api/show/user.getRecentTracks), [About de WhatsApp](https://blog.whatsapp.com/reintroducing-about-an-improved-way-to-share-what-youre-up-to).
