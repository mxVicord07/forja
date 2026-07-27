# forjabot

**Chatbots de IA para tu negocio, desde tu terminal.** `forjabot` instala y mantiene
bots de IA por giro (restaurante, barbería, inmobiliaria, clínica…) en **tu propia
cuenta de Cloudflare**, con **tus llaves**. El bot es tuyo — para usarlo o revenderlo.

Pensado para que lo maneje tu **agente de IA** (Claude Code o Codex): tú respondes
preguntas de negocio y apruebas; el agente corre lo técnico.

> Parte de [Forja](https://horizontesia.com), la plataforma de chatbots de Horizontes IA.

---

## Instalación

No necesitas instalar nada global. Se corre con `npx`:

```bash
npx forjabot init
```

Requisitos:

- **Node 18+** (para `npx`).
- Una cuenta **gratis de Cloudflare** (ahí vive tu bot).
- Un **agente de IA** — [Claude Code](https://claude.com/claude-code) o Codex — para ejecutar los pasos.
- Una **llave de IA** (Anthropic, OpenAI o xAI). Se guarda como *secreto de Cloudflare*, nunca en el CLI.

## Inicio rápido

```bash
# 1 · asistente: elige idioma, licencia (gratis o Forja+) y giro
npx forjabot init

# 2 · verifica que todo esté sano
npx forjabot doctor

# 3 · mantente al día cuando saquemos mejoras (sin perder tu configuración)
npx forjabot update
```

`init` baja la plantilla del giro que elijas y te hace unas preguntas del negocio.
Al terminar, tu agente despliega el bot a Cloudflare y tú abres tu panel en
`https://<tu-worker>.workers.dev/admin`.

### Tu agente aprende a usar Forja

La primera vez, `forjabot` instala una guía para tu agente en
`~/.claude/skills/forja/` (Claude Code). Con eso tu agente sabe cómo usar el CLI y el flujo
completo: instalar, configurar, desplegar y operar el bot. Puedes desactivarlo con
`--no-agent-skill` o la variable `FORJA_NO_AGENT_SKILL=1`.

## Comandos

| Comando | Qué hace |
|---|---|
| `forjabot init` | Asistente interactivo: idioma (ES/EN), licencia (gratis con tu correo o key `HZN-…`), elige el giro e instala. |
| `forjabot list` | Muestra el catálogo de bots disponibles para tu plan. |
| `forjabot install <slug>` | Instala un giro específico (p. ej. `restaurante`, `barberia`, `inmobiliaria`). |
| `forjabot update [carpeta]` | Trae la versión nueva **conservando** tu `member/` (config, base de conocimiento). |
| `forjabot doctor [carpeta]` | Diagnóstico del bot instalado: versión, archivos, licencia y si el worker responde. |

Opciones útiles:

- `--key HZN-XXXX-XXXX-XXXX` — pasa tu licencia de Forja+ sin el asistente (`install` / `update` / `init`).
- `--email tu@correo.com` `--name "Tu Nombre"` — para el arranque gratis sin teclear (útil si tu teclado no mete la `@` en la terminal).
- Todo el onboarding acepta flags (pensado para que tu **agente** lo corra sin menús):
  `--giro --negocio --que --ofrece --horario --ubicacion --telefono --web --pagos --faq --reglas --tono --cerebro --yes`.

El asistente usa **menús con flechas** (↑/↓ + enter). Si corres en un entorno sin
terminal interactiva (CI, scripts), cae automáticamente a listas numeradas.

¿No tienes licencia de Forja+? La obtienes al **entrar a la comunidad de Horizontes IA**
([horizontesia.com](https://horizontesia.com)): ahí recibes tu llave `HZN-…`.

La licencia y el idioma se guardan en `~/.forja/config.json`. La versión instalada
vive en el marcador `.horizontes-bot.json` dentro de la carpeta de tu bot.

## Los comandos del agente

Una vez instalado, operas el bot pidiéndole **skills** a tu agente (no son subcomandos
de `forjabot`, son instrucciones que tu agente ejecuta sobre el bot ya instalado):

- `reporte`, `exportar`, `analiticas`, `human-in-the-loop`, `conectar-mi-ia` (conecta tu propia IA) — el día a día. *(Gratis)*
- `superpoderes` (enciende y configura los 12), `reportes` (reporte diario con tu marca), `conexiones-composio` (conecta apps: Gmail, Slack…), `voz-de-marca`, `mantenimiento`, `afinar`, `campaña`, `clonar`, `precios` — operación y ajustes. *(Forja+)*
- **Modo Agencia:** `cliente-nuevo`, `cliente-misterioso` (demo para un prospecto), `roi`, `cotizar`, `propuesta`, `cobrar` — para revender. *(Forja+)*

Le hablas normal a tu agente ("hazme el reporte del mes") y él sabe cuál usar.

## Planes

- **Gratis** — instala el bot Starter, captura leads, panel básico. Se obtiene con tu correo.
- **Forja +** — los 14 giros con sus paneles, los comandos recurrentes y el Modo Agencia.
  Se activa con una key `HZN-…`. → [Únete a Forja +](https://horizontesia.com)

La licencia se hace cumplir en la distribución: sin licencia activa no bajas bots
premium ni actualizas. **Tu bot instalado nunca se apaga por esto** — sigue corriendo.

## Documentación

Guía completa, referencia de comandos y conexiones:
**https://forjabots.com/docs/**

## Privacidad

`forjabot` corre en tu máquina. No sube tu código ni los datos de tus clientes a
Horizontes: solo valida tu licencia y baja el bot desde el control plane. El bot y
todos sus datos viven en **tu** Cloudflare, con **tus** llaves.

---

© Horizontes IA · [horizontesia.com](https://horizontesia.com)

## 🔍 ¿Es seguro? Verifícalo tú mismo

Es sano desconfiar de un `npx` que no conoces — si tu agente de IA se niega a ejecutarlo, está haciendo su trabajo. Aquí está todo lo que necesitas para comprobarlo en un minuto:

- **El código es este mismo repositorio**, carpeta [`cli/`](./bin/cli.js). Lo que se publica en npm es exactamente ese archivo: puedes leerlo completo antes de correr nada.
- **No tiene dependencias.** Cero paquetes de terceros: el `package.json` no declara ninguna. Nada que se pueda comprometer río arriba.
- **No recolecta datos tuyos.** No manda telemetría ni analíticas. Solo habla con el servidor de licencias para validar tu llave y bajar el bot, y con npm para instalarse.
- **Tu API key nunca pasa por aquí.** El CLI jamás la pide ni la guarda: va como secreto a *tu* cuenta de Cloudflare (`wrangler secret put`).
- **Licencia MIT**, publicado por Horizontes IA.

Compruébalo con:

```bash
npm view forjabot            # autor, licencia, repositorio
npm view forjabot dist.tarball   # bájalo y léelo antes de ejecutarlo
```

Y si prefieres no usar `npx`, clona este repo y corre `node cli/bin/cli.js init` directamente.

### Por qué el CLI pide estos permisos

Los escáneres de cadena de suministro (Socket y similares) marcan las *capacidades* de un paquete. Un instalador necesita varias por definición; aquí está para qué usa cada una, y puedes comprobarlo en [`bin/cli.js`](./bin/cli.js):

| Capacidad | Para qué la usa | Cómo está acotada |
|---|---|---|
| **Red** (`node:http`) | Levanta un servidor **local en 127.0.0.1** que recibe el regreso del navegador al hacer `forjabot login`. | Solo escucha en tu propia máquina, en un puerto temporal, y se cierra al terminar. Las llamadas a internet van por `fetch` a nuestro servidor de licencias. |
| **Shell** (`node:child_process`) | Descomprimir el bot (`tar`), abrir tu navegador en el login, y correr `wrangler` para guardar tus secretos en TU Cloudflare. | Siempre con `execFileSync` y **arreglo de argumentos**, nunca una cadena de shell: no hay forma de inyectar comandos. Cero `shell: true`. |
| **Variables de entorno** | Únicamente las suyas: `FORJA_SERVER`, `FORJA_CLOUD`, `FORJA_GET_URL`, `FORJA_YES`, `FORJA_NO_ART`, `FORJA_NO_BROWSER`, `FORJA_NO_AGENT_SKILL`, `HORIZONTES_KEY`, `HORIZONTES_SERVER`, y `NO_COLOR` (estándar). | **No lee ninguna credencial del sistema.** Nada de tokens de nube, claves de npm ni variables ajenas. |
| **Sistema de archivos** | Escribe la carpeta del bot que instalas y tu configuración en `~/.forja/`. | Nada fuera de eso. |
| **Cadenas URL** | Los dominios propios: forjabots.com y el servidor de licencias. | No hay direcciones IP ni dominios de terceros. |

Y lo más importante: **tu API key nunca pasa por el CLI**. Cuando toca guardarla, se hace con `wrangler secret put` contra *tu* cuenta de Cloudflare — el CLI nunca la recibe, ni la escribe en disco, ni la manda a ningún lado.
