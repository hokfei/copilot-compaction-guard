import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { joinSession } from "@github/copilot-sdk/extension";

// ---- config: Zen-backed custom provider + DeepSeek fallback ----
// Env-overridable so the published extension works beyond one machine.
// If the custom provider is ever recreated (new id), set COMPACTION_GUARD_PROVIDER_ID.
const PROVIDER_ID = process.env.COMPACTION_GUARD_PROVIDER_ID || "c54b9653-0828-4c58-9a6f-bc67320cfea8";
const FALLBACK_SHORT = process.env.COMPACTION_GUARD_FALLBACK_MODEL || "deepseek-v4.1-flash";
const FALLBACK_MODEL = `${PROVIDER_ID}/${FALLBACK_SHORT}`;

const short = (m) => (typeof m === "string" && m.includes("/") ? m.split("/").pop() : m);

// ---- state (per session: the host forks one process per session) ----
let switchedFrom = null; // model id we moved away from; null = no active swap
let lastCompactionModel = null;
const startModels = new Map(); // compactionAttemptId -> model

function statusText() {
  return [
    "compaction-guard:",
    `- fallback model: ${FALLBACK_MODEL}`,
    switchedFrom
      ? `- SWAPPED: session moved from ${switchedFrom} to ${FALLBACK_SHORT}; restore on next successful compaction`
      : "- armed: no active swap",
    lastCompactionModel ? `- last compaction model seen: ${lastCompactionModel}` : "- no compaction observed yet",
  ].join("\n");
}

function readSessionRow(sessionId) {
  try {
    const dbPath = join(homedir(), ".copilot", "data.db");
    if (!existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare("SELECT model, reasoning_effort FROM sessions WHERE id = ?").get(sessionId) ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function setModelBestEffort(model, effort) {
  try {
    if (effort) await session.setModel(model, { reasoningEffort: effort });
    else await session.setModel(model);
    return true;
  } catch {
    if (model === FALLBACK_MODEL) {
      await session.setModel(FALLBACK_SHORT); // let it throw
      return true;
    }
    throw new Error(`setModel rejected ${model}`);
  }
}

async function maybeSwitchToFallback(reason) {
  if (switchedFrom) return; // a swap is already active; never stack or loop
  const row = readSessionRow(session.sessionId);
  const current = row?.model ?? lastCompactionModel;
  if (!current || !current.startsWith(PROVIDER_ID)) return; // only manage our Zen models
  if (current === FALLBACK_MODEL || current === FALLBACK_SHORT) return; // already on the fallback
  switchedFrom = current;
  try {
    await setModelBestEffort(FALLBACK_MODEL);
  } catch (err) {
    switchedFrom = null;
    await session.log(`compaction-guard: compaction failed on ${short(current)} but the DeepSeek swap failed: ${err.message}`);
    return;
  }
  await session.log(
    `compaction-guard: compaction failed on ${short(current)} (${reason}); ` +
      `switched to ${FALLBACK_SHORT} for the retry. Your model is restored automatically after compaction succeeds.`
  );
}

async function maybeRestore(successModel) {
  if (!switchedFrom) return;
  if (successModel !== FALLBACK_MODEL && successModel !== FALLBACK_SHORT) {
    switchedFrom = null; // compaction ran on some other model (manual switch?) — stand down
    return;
  }
  const back = switchedFrom;
  switchedFrom = null;
  const row = readSessionRow(session.sessionId);
  try {
    await setModelBestEffort(back, row?.reasoning_effort ?? null);
  } catch (err) {
    await session.log(
      `compaction-guard: compaction succeeded but restoring ${short(back)} failed: ${err.message}. ` +
        `Session is still on ${FALLBACK_SHORT} — switch back manually when ready.`
    );
    return;
  }
  await session.log(`compaction-guard: compaction succeeded — restored ${short(back)}.`);
}

const session = await joinSession({
  tools: [
    {
      name: "compaction_guard_status",
      description:
        "Show compaction-guard state: whether the DeepSeek fallback swap is armed or active.",
      parameters: { type: "object", properties: {} },
      handler: async () => statusText(),
    },
  ],
  hooks: {
    // Backup signal: if a compaction failure ever surfaces without a completion event.
    onErrorOccurred: async (input) => {
      if (input?.errorContext !== "model_call") return;
      if (!/compact/i.test(input?.error ?? "")) return;
      await maybeSwitchToFallback("model-call error mentioning compaction");
    },
  },
});

session.on((event) => {
  void (async () => {
    try {
      if (event?.type === "session.compaction_start") {
        const d = event.data ?? {};
        if (d.compactionAttemptId && d.model) startModels.set(d.compactionAttemptId, d.model);
        if (d.model) lastCompactionModel = d.model;
      } else if (event?.type === "session.compaction_complete") {
        const d = event.data ?? {};
        const attemptModel =
          (d.compactionAttemptId && startModels.get(d.compactionAttemptId)) || d.model || lastCompactionModel;
        if (d.compactionAttemptId) startModels.delete(d.compactionAttemptId);
        if (d.success === false) {
          lastCompactionModel = attemptModel;
          await maybeSwitchToFallback(d.error ?? d.failureReason ?? "compaction failed");
        } else if (d.success === true) {
          await maybeRestore(d.model ?? attemptModel);
        }
      }
    } catch (err) {
      await session.log(`compaction-guard: internal error: ${err?.message ?? err}`, { ephemeral: true });
    }
  })();
});

await session.log(`compaction-guard ready (${FALLBACK_SHORT} fallback armed)`, { ephemeral: true });
