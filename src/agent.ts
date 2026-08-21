import { Agent } from "agents";
import { streamText } from "ai";
import type { SystemModelMessage } from "ai";
import type { Env } from "./env";
import { Db } from "./db/client";
import { ConversationsRepo } from "./db/conversations";
import { MessagesRepo } from "./db/messages";
import { isPro } from "./config";
import { resolveAgentConfig } from "./settings-loader";
import { buildTools } from "./tools";
import { buildMultimodalUserMessage } from "./media/vision";
import { chunkReply } from "./replies/chunker";
import { pickAdapter } from "./replies/sender";
import { showTypingSafe, startTypingKeepalive } from "./replies/typing";
import { selectModel } from "./upgrade/modelSelector";
import type { Tier } from "./upgrade/modelSelector";
import { monthIaCostUsd, applyBudgetGuard } from "./budget";
import { CustomerFactsRepo } from "./db/facts";
import { createModel } from "./llm/provider";
import { costOfUsage } from "./pricing";
import type { ChannelId } from "./channels/shared";
import { guardReply } from "./blindaje/verify";
import type { DocumentRow } from "./db/documents";
import { signedFileUrl } from "./files/share";
import type { SearchKbResult } from "./tools/searchKb";
import { SettingsRepo, SETTING_KEYS } from "./db/settings";
import { renderBusinessContext } from "./businessContext";
import { maskTelegramToken, unmaskTelegramToken } from "./telegramFiles";

export interface SupportAgentState {
  conversationId: string | null;
  channel: string;
  channelUserId: string;
  pendingMessages: { text: string; receivedAt: number }[];
  lastAlarmAt: number;
  lastUserLang: string;
  toolCallsInLast2Turns: number;
  lastSearchKbScore: number;
  imageRetryCount: number;
  /** Id del último mensaje entrante del lado del proveedor (wamid en WhatsApp).
   *  Lo exige el indicador de "escribiendo…" cuando se re-enciende desde el
   *  alarm, ya fuera del webhook que lo trajo. */
  lastProviderMessageId: string;
}

export interface AgentIncomingPayload {
  channel: string;
  channelUserId: string;
  providerMessageId?: string;
  displayName?: string;
  text?: string;
  audioUrl?: string;
  imageUrl?: string;
  isOwnerMessage?: boolean;
}

export class SupportAgent extends Agent<Env, SupportAgentState> {
  initialState: SupportAgentState = {
    conversationId: null,
    channel: "",
    channelUserId: "",
    pendingMessages: [],
    lastAlarmAt: 0,
    lastUserLang: "es",
    toolCallsInLast2Turns: 0,
    lastSearchKbScore: 1,
    imageRetryCount: 0,
    lastProviderMessageId: "",
  };

  /**
   * Called by the Worker fetch handler when a webhook arrives for this user.
   * Buffers the message, schedules/resets an alarm.
   */
  async ingest(payload: AgentIncomingPayload): Promise<{ acknowledged: true }> {
    const db = new Db(this.env.DB);
    const convs = new ConversationsRepo(db);
    const conv = await convs.getOrCreate(
      payload.channel,
      payload.channelUserId,
      payload.displayName,
    );
    this.setState({
      ...this.state,
      channel: payload.channel,
      channelUserId: payload.channelUserId,
      conversationId: conv.id,
    });

    // Owner intervened → pause the bot, do NOT process this as user input
    if (payload.isOwnerMessage) {
      const pausedUntil = Date.now() + 60 * 60 * 1000;
      await convs.setPausedUntil(conv.id, pausedUntil);
      return { acknowledged: true };
    }

    // If paused, ignore (bot stays silent)
    if (await convs.isPaused(conv.id)) {
      return { acknowledged: true };
    }

    // Guardrail anti-spam: el mismo mensaje por 3ª vez entre los últimos 5 →
    // la conversación descansa 1 hora, sin respuesta y sin gastar LLM.
    if (payload.text && !payload.audioUrl && !payload.imageUrl) {
      try {
        const { isRepeatSpam, SPAM_SNOOZE_MS, isOverDailyCap, DAILY_CAP_SNOOZE_MS, DAILY_CAP_MESSAGE } =
          await import("./spam");
        if (await isRepeatSpam(db, conv.id, payload.text)) {
          await convs.setPausedUntil(conv.id, Date.now() + SPAM_SNOOZE_MS);
          console.warn(`[spam-guard] conv ${conv.id} en cooldown 1h (mensaje repetido)`);
          return { acknowledged: true };
        }
        // Tope diario de turnos: despedida amable UNA vez + descanso 12h. La
        // pausa garantiza que no se repita (los siguientes mensajes mueren en
        // isPaused antes de llegar aquí).
        if (await isOverDailyCap(db, conv.id)) {
          await convs.setPausedUntil(conv.id, Date.now() + DAILY_CAP_SNOOZE_MS);
          await new MessagesRepo(db).append(conv.id, "assistant", DAILY_CAP_MESSAGE);
          const channel = payload.channel as ChannelId;
          await pickAdapter(channel, this.env).sendReply(
            { channel, channelUserId: payload.channelUserId, chunks: [DAILY_CAP_MESSAGE] },
            this.env,
          );
          console.warn(`[spam-guard] conv ${conv.id} tope diario de turnos → descanso 12h`);
          return { acknowledged: true };
        }
      } catch (e) {
        // El guard es un extra, nunca la ruta crítica: si falla, se responde normal.
        console.warn("[spam-guard] check failed:", e);
      }
    }

    // ── "Escribiendo…" (los tres puntitos) ────────────────────────────────
    // Se enciende ACÁ, no más adelante, por dos razones: (1) a esta altura ya
    // pasaron todos los guards (dueño interviniendo, conversación pausada,
    // spam, tope diario), así que sí vamos a contestar — única condición bajo
    // la que Meta/WhatsApp permiten mostrarlo; (2) va ANTES de transcribir el
    // audio o anotar la imagen, que son justo los segundos de silencio que
    // queremos tapar. En WhatsApp esta misma llamada marca el mensaje como
    // leído (palomitas azules): es el mismo endpoint, y es la señal que
    // buscamos — "ya te leí, ahí voy".
    // Nunca es ruta crítica: si algo falla acá, el turno sigue igual.
    try {
      const cfgEarly = await resolveAgentConfig(this.env, []);
      if (cfgEarly.typingIndicator && !cfgEarly.botPaused) {
        const ch = payload.channel as ChannelId;
        await showTypingSafe(
          pickAdapter(ch, this.env),
          ch,
          payload.channelUserId,
          this.env,
          payload.providerMessageId,
        );
      }
    } catch (e) {
      console.warn("[typing] no se pudo encender al recibir:", e);
    }

    // Process media (audio → transcription, image → Pro-gated multimodal marker)
    let processedText = payload.text ?? "";
    let hasImage = false;

    if (payload.audioUrl) {
      try {
        const { transcribeAudio } = await import("./media/transcribe");
        const result = await transcribeAudio(payload.audioUrl, this.env);
        processedText = result.text || "(audio sin transcripción)";
      } catch (e) {
        console.error("[ingest] transcription failed:", e);
        processedText = "(no pude entender el audio)";
      }
    }

    if (payload.imageUrl) {
      hasImage = true;
      // Pro-only: if free tier, strip the image and inform the bot owner-side
      if (!isPro(this.env)) {
        processedText =
          (processedText || "") +
          "\n(El cliente mandó una imagen, pero tu plan no soporta análisis de imágenes.)";
      } else {
        // Telegram file URLs carry the bot token (see src/telegramFiles.ts) —
        // mask it before this text is persisted to D1.
        processedText =
          (processedText || "(imagen sin caption)") +
          `\n[IMAGE_URL: ${maskTelegramToken(payload.imageUrl)}]`;
      }
    }

    // Append to buffer (we always persist the client's message)
    const pending = [
      ...this.state.pendingMessages,
      { text: processedText, receivedAt: Date.now() },
    ];
    this.setState({
      ...this.state,
      pendingMessages: pending,
      imageRetryCount: hasImage ? 0 : this.state.imageRetryCount,
      // El alarm corre fuera del webhook: sin guardar el id acá, el keepalive
      // del indicador se quedaría sin a qué mensaje colgarse en WhatsApp.
      lastProviderMessageId: payload.providerMessageId ?? this.state.lastProviderMessageId,
    });

    // Resolve effective config (D1 settings overlaid on env defaults).
    // We need at least bot_paused (to decide whether to reply) and the buffer.
    const cfg = await resolveAgentConfig(this.env, []);

    // Owner paused the bot via the dashboard → keep the message buffered but
    // stay silent: do NOT arm the alarm, so alarm() never runs.
    if (cfg.botPaused) {
      return { acknowledged: true };
    }

    // Schedule buffer processing via the agents SDK scheduler.
    // The SDK overrides alarm() to dispatch named callbacks from its
    // cf_agents_schedules table, so raw ctx.storage.setAlarm() alone won't
    // invoke our code. We upsert a fixed 'msg-buffer' row (so rapid messages
    // debounce to a single fire) and set the raw alarm as the trigger.
    const alarmAt = Date.now() + cfg.bufferMs;
    const alarmAtSec = Math.floor(alarmAt / 1000);
    this.sql`
      INSERT OR REPLACE INTO cf_agents_schedules
        (id, callback, payload, type, time, created_at)
      VALUES
        ('msg-buffer', 'processBuffer', '{}', 'delayed', ${alarmAtSec}, unixepoch())
    `;
    await this.ctx.storage.setAlarm(alarmAt);
    this.setState({ ...this.state, lastAlarmAt: alarmAt });

    return { acknowledged: true };
  }

  /**
   * Called by the agents SDK scheduler when the msg-buffer task fires.
   * Processes accumulated messages as one input, runs the LLM loop, and
   * sends the chunked reply over the channel adapter.
   */
  async processBuffer(): Promise<void> {
    const buffered = [...this.state.pendingMessages];
    this.setState({ ...this.state, pendingMessages: [] });
    if (buffered.length === 0) return;

    const combined = buffered.map((m) => m.text).join("\n").trim();
    if (!combined) return;

    const db = new Db(this.env.DB);
    const msgs = new MessagesRepo(db);
    const convs = new ConversationsRepo(db);
    const convId = this.state.conversationId;
    if (!convId) {
      console.warn("[SupportAgent.processBuffer] no conversation_id in state");
      return;
    }

    // Persist user message
    await msgs.append(convId, "user", combined);
    await convs.touchLastMessage(convId);

    // Load history (last 20)
    const history = await msgs.lastN(convId, 20);
    const aiMessages: any[] = history.slice(0, -1).map((m) => ({
      role: (m.role === "tool"
        ? "user"
        : m.role === "owner"
          ? "assistant"
          : m.role) as "user" | "assistant",
      content: m.content,
    }));
    // Build the LAST user message multimodal-aware: if it carries an
    // [IMAGE_URL: ...] marker AND we're on the Pro tier, attach the image.
    const lastUserMsg = history[history.length - 1];
    if (lastUserMsg) {
      const imgMatch = lastUserMsg.content.match(/\[IMAGE_URL: (.+?)\]/);
      if (imgMatch && isPro(this.env)) {
        // Put the token back (if this was a masked Telegram URL) right before
        // fetching the file — see src/telegramFiles.ts.
        const imageUrl = unmaskTelegramToken(imgMatch[1], this.env.TELEGRAM_BOT_TOKEN);
        const cleanText = lastUserMsg.content
          .replace(/\n?\[IMAGE_URL: .+?\]/, "")
          .trim();
        aiMessages.push(buildMultimodalUserMessage(cleanText, imageUrl));
      } else {
        aiMessages.push({ role: "user", content: lastUserMsg.content });
      }
    }

    // Blindaje anti-invento: pasajes de KB consultados ESTE turno. searchKb
    // los reporta vía callback — el verificador pre-envío los usa como fuente
    // de verdad. De paso revive lastSearchKbScore (antes era un campo muerto:
    // se leía para selectModel pero nunca se actualizaba con el score real).
    let turnKbPassages: SearchKbResult[] = [];
    let turnUsedKb = false;
    let lastKbTopScore = 1;
    // Documento que shareDocument decidió mandar este turno (si lo hubo). Se
    // envía DESPUÉS del texto de la respuesta — ver el bloque de envío abajo.
    let docToShare: DocumentRow | null = null;

    // Build tools registry (tier-gated in buildTools)
    const tools = buildTools({
      env: this.env,
      getConversationId: () => convId,
      onSearchKb: (results) => {
        turnUsedKb = true;
        turnKbPassages = [...turnKbPassages, ...results].slice(-10);
        lastKbTopScore = results[0]?.score ?? 0;
      },
      onShareDocument: (doc) => {
        docToShare = doc;
      },
      getChannel: () => this.state.channel ?? null,
    });
    const toolNames = Object.keys(tools);

    // Resolve effective config (D1 settings overlaid on env defaults).
    const cfg = await resolveAgentConfig(this.env, toolNames);

    // ── "Escribiendo…" mientras el bot piensa ─────────────────────────────
    // El indicador ya se encendió al recibir el mensaje (ver ingest), pero
    // todos los proveedores lo apagan solos — Telegram a los ~5s,
    // Messenger/Instagram a los ~20s, WhatsApp a los 25s — y entre el buffer
    // y el turno del LLM suele pasar más que eso. El keepalive lo re-enciende
    // hasta que la respuesta sale; sin él, el cliente ve puntitos un instante
    // y luego un silencio largo, que se siente peor que no mostrarlos.
    // Sigue vivo DURANTE el envío a propósito: entre un chunk y el siguiente
    // el cliente ve "escribiendo…" otra vez, como con una persona real.
    const channel = this.state.channel as ChannelId;
    const adapter = pickAdapter(channel, this.env);
    const stopTyping = cfg.typingIndicator
      ? startTypingKeepalive(
          adapter,
          channel,
          this.state.channelUserId,
          this.env,
          this.state.lastProviderMessageId || undefined,
        )
      : () => {};
    try {

      // Honor the dashboard's tool toggles: the prompt already only advertises
      // enabled tools (settings-loader), so the registry must match.
      const enabledTools = Object.fromEntries(
        Object.entries(tools).filter(([name]) => cfg.enabledToolNames.includes(name)),
      );

      // Select tier: honor an explicit override, otherwise auto-select. The active
      // provider (Anthropic default | OpenAI) maps the tier to a concrete model id.
      let tier: Tier =
        cfg.modelOverride === "haiku"
          ? "fast"
          : cfg.modelOverride === "sonnet"
            ? "smart"
            : selectModel({
                toolCallsInLast2Turns: this.state.toolCallsInLast2Turns,
                lastUserText: combined,
                lastUserLang: this.env.BOT_LANGUAGE,
                hasImage: false,
                imageRetryCount: this.state.imageRetryCount,
                lastSearchKbScore: this.state.lastSearchKbScore,
              });

      // Budget guard: at/over the monthly AI budget the bot keeps answering but
      // only on the cheap tier (never goes silent over money).
      if (cfg.monthlyBudgetUsd !== undefined && tier !== "fast") {
        const spent = await monthIaCostUsd(db);
        const guard = applyBudgetGuard(tier, spent, cfg.monthlyBudgetUsd);
        if (guard.downgraded) {
          console.warn(
            `[SupportAgent] monthly budget reached ($${spent.toFixed(2)}/$${cfg.monthlyBudgetUsd}) — downgrading to fast tier`,
          );
        }
        tier = guard.tier;
      }

      const { model, modelId, supportsPromptCache } = createModel(this.env, tier, cfg.llm);

      // Cache the (large, stable) system prompt with an ephemeral cache breakpoint.
      // Only the system block is cached — messages change every turn. Cache hits
      // show up in usage.cachedInputTokens (read below for cost accounting).
      // Prompt caching is Anthropic-only; on OpenAI we send the plain system block.
      const system: SystemModelMessage[] = [
        {
          role: "system",
          content: cfg.systemPrompt,
          ...(supportsPromptCache
            ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
            : {}),
        },
      ];

      // Customer memory (flywheel): facts extracted by the insights analyzer are
      // injected as a small UNCACHED system block, so a returning customer is
      // greeted by a bot that remembers them. The big prompt above stays cached.
      // Memory is an enhancement, never the critical path: if the lookup fails,
      // the reply still goes out.
      try {
        const facts = await new CustomerFactsRepo(db).forConversation(convId, 8);
        if (facts.length > 0) {
          system.push({
            role: "system",
            content: `<cliente>\nLo que ya sabes de este cliente (de conversaciones pasadas):\n${facts
              .map((f) => `- ${f.fact}`)
              .join("\n")}\n</cliente>`,
          });
        }
      } catch (e) {
        console.warn("[SupportAgent] customer facts lookup failed:", e);
      }

      let assistantText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let toolCallCount = 0;
      let toolCallsMade: { toolName: string; input: unknown }[] = [];
      let usedModelId = modelId;

      // Corre el loop del LLM con un modelo dado; deja los resultados en las vars.
      const attempt = async (m: any) => {
        const result = streamText({
          model: m,
          system,
          messages: aiMessages,
          tools: enabledTools,
          stopWhen: ({ steps }) => steps.length >= 6,
          ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
        });
        let text = "";
        for await (const chunk of result.textStream) {
          text += chunk;
        }
        assistantText = text;
        const usage = await result.usage;
        inputTokens = usage?.inputTokens ?? 0;
        outputTokens = usage?.outputTokens ?? 0;
        cachedTokens = usage?.cachedInputTokens ?? 0;
        const steps = await result.steps;
        toolCallCount = steps.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0);
        // Persist what the agent DID (not just what it said): tool name + input,
        // feeding the dashboard's thread chips, stats and the Mi Agente counters.
        toolCallsMade = steps.flatMap((s) =>
          (s.toolCalls ?? []).map((tc: any) => ({
            toolName: tc.toolName as string,
            input: tc.input,
          })),
        );
      };

      try {
        await attempt(model);
      } catch (e: any) {
        // FAILOVER con backoff: en ráfagas (historias) el primario suele dar un
        // rate-limit TRANSITORIO — esperar con jitter y reintentar resuelve la
        // mayoría; si no, se prueba el proveedor alterno (también con un segundo
        // intento). El jitter des-sincroniza mensajes que llegaron en el mismo
        // segundo. El bot no puede quedarse mudo el día del evento.
        console.error("[SupportAgent.processBuffer] streamText failed:", e);
        const backoff = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const { fallbackModel } = await import("./llm/provider");
        const primary = createModel(this.env, tier, cfg.llm);
        const fb = fallbackModel(this.env, tier, primary.provider);
        let ok = false;

        await backoff(2000 + Math.floor(Math.random() * 1500));
        try {
          await attempt(model);
          ok = true;
        } catch (e1: any) {
          console.error("[SupportAgent.processBuffer] primary retry failed:", e1);
        }

        if (!ok && fb) {
          console.warn(
            `[SupportAgent] failover ${primary.provider} → ${fb.provider}/${fb.modelId}`,
          );
          try {
            await attempt(fb.model);
            usedModelId = fb.modelId;
            ok = true;
          } catch (e2: any) {
            console.error("[SupportAgent.processBuffer] fallback failed:", e2);
            await backoff(2500 + Math.floor(Math.random() * 1500));
            try {
              await attempt(fb.model);
              usedModelId = fb.modelId;
              ok = true;
            } catch (e3: any) {
              console.error("[SupportAgent.processBuffer] fallback retry failed:", e3);
            }
          }
        }

        if (!ok) {
          assistantText = "Algo falló de mi lado, intenta de nuevo en un momento.";
        }
      }

      // ── Blindaje anti-invento (Pro): verificación pre-envío ──────────────────
      // Antes de mandar una respuesta que afirme datos (precio/horario/promesa),
      // se contrasta contra los pasajes de KB del turno + contexto del negocio +
      // el system prompt activo. Sin respaldo → sale un "déjame confirmarlo" y
      // se avisa al dueño (ticket, misma maquinaria del handoff). FAIL-OPEN:
      // cualquier error/timeout del verificador manda la respuesta original
      // intacta — jamás bloquea un envío.
      if (assistantText) {
        try {
          const settings = new SettingsRepo(db);
          const businessContext =
            (await settings.get(SETTING_KEYS.businessContext)) || renderBusinessContext();
          const guard = await guardReply(this.env, {
            replyText: assistantText,
            turnUsedKb,
            kbPassages: turnKbPassages,
            businessContext,
            systemPrompt: cfg.systemPrompt,
            conversationId: convId,
            llm: cfg.llm,
          });
          if (guard.action === "replaced") {
            assistantText = guard.finalText;
          }
        } catch (e) {
          console.warn("[blindaje] guard falló — fail-open, va la respuesta original:", e);
        }
      }

      // Persist assistant message (with usage + model_used + tool calls)
      await msgs.append(convId, "assistant", assistantText, {
        modelUsed: usedModelId,
        inputTokens,
        outputTokens,
        cachedInputTokens: cachedTokens,
        toolCalls: toolCallsMade.length > 0 ? toolCallsMade : undefined,
      });

      // Update state for next turn. lastSearchKbScore = score top-1 de la última
      // búsqueda en KB del turno: si vino débil (<0.5) el selector sube a "smart"
      // el siguiente turno (upgrade/modelSelector). Sin búsqueda este turno
      // regresa a neutral (1) — el boost dura un turno.
      this.setState({
        ...this.state,
        toolCallsInLast2Turns: toolCallCount,
        lastSearchKbScore: turnUsedKb ? lastKbTopScore : 1,
      });

      // Chunk + send via the channel adapter
      const chunks = chunkReply(assistantText, cfg.maxChunks);
      await adapter.sendReply(
        {
          channel,
          channelUserId: this.state.channelUserId,
          chunks,
          interChunkDelayMs: cfg.interChunkDelayMs,
        },
        this.env,
      );

      // ── Documento compartible (shareDocument) ───────────────────────────
      // Va DESPUÉS del texto a propósito: el cliente primero lee la
      // explicación del bot, luego recibe el PDF — como lo haría una
      // persona. Nunca bloquea nada: sin soporte del canal (ManyChat,
      // Twilio) o sin URL firmada (falta DASHBOARD_BASE_URL) se salta con un
      // warn, el turno ya se considera exitoso porque el texto ya salió.
      // `as DocumentRow | null`: docToShare solo se reasigna dentro del closure
      // onShareDocument (arriba), y TS no ve esa escritura como parte del flujo
      // lineal — lo narrowea a `null` para siempre y `if (docToShare)` da
      // `never`. El cast restaura el tipo declarado sin cambiar nada en runtime.
      const doc = docToShare as DocumentRow | null;
      if (doc && adapter.sendDocument) {
        try {
          const url = await signedFileUrl(doc.id, this.env, "");
          if (url) {
            await adapter.sendDocument(
              {
                channel,
                channelUserId: this.state.channelUserId,
                url,
                filename: doc.filename,
                mimeType: doc.mime_type,
                caption: doc.title,
              },
              this.env,
            );
          } else {
            console.warn("[shareDocument] sin DASHBOARD_BASE_URL/secret — no se pudo firmar la URL");
          }
        } catch (e) {
          console.warn("[shareDocument] no se pudo enviar el documento:", e);
        }
      }

      console.log(
        `[SupportAgent.processBuffer] sent ${chunks.length} chunks, model=${usedModelId}, cost=$${costOfUsage(
          usedModelId,
          { input: inputTokens, cached: cachedTokens, output: outputTokens },
        ).toFixed(5)}`,
      );
    } finally {
      // Pase lo que pase (respuesta enviada, LLM caído, D1 con error) el
      // keepalive tiene que morir: si no, sigue latiendo dentro del Durable
      // Object hasta su tope duro, encendiéndole puntitos a un cliente que ya
      // no espera nada.
      stopTyping();
    }
  }
}
