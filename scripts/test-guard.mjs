// Self-contained unit test for the compaction-guard extension.
// Builds a sandbox with a mocked @github/copilot-sdk, loads a copy of
// extension.mjs into it, and drives the compaction event flow.
//
// Run: npm test (or: node scripts/test-guard.mjs)
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MOCK_SDK = `
export const captured = { config: null, session: null };
export async function joinSession(config) {
  const session = {
    sessionId: "test-session-id",
    _eventHandler: null,
    _models: [],
    _logs: [],
    _rejectFull: false,
    on(handler) { session._eventHandler = handler; return () => {}; },
    async setModel(model, options) {
      if (session._rejectFull && model.includes("/")) throw new Error("rejected full form");
      session._models.push({ model, options });
    },
    async log(msg) { session._logs.push(msg); },
    emit(event) { return session._eventHandler(event); },
  };
  captured.config = config;
  captured.session = session;
  return session;
}
`;

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, "..");
const sandbox = mkdtempSync(join(tmpdir(), "guard-test-"));
try {
  mkdirSync(join(sandbox, "node_modules", "@github", "copilot-sdk"), { recursive: true });
  writeFileSync(
    join(sandbox, "node_modules", "@github", "copilot-sdk", "package.json"),
    JSON.stringify({ name: "mock-sdk", version: "0.0.0", type: "module", exports: { "./extension": "./extension.js" } })
  );
  writeFileSync(join(sandbox, "node_modules", "@github", "copilot-sdk", "extension.js"), MOCK_SDK);
  copyFileSync(join(extRoot, "extension.mjs"), join(sandbox, "extension.mjs"));

  const sdkUrl = pathToFileURL(join(sandbox, "node_modules", "@github", "copilot-sdk", "extension.js")).href;
  const { captured } = await import(sdkUrl);
  await import(pathToFileURL(join(sandbox, "extension.mjs")).href);

  const PID = "c54b9653-0828-4c58-9a6f-bc67320cfea8";
  const SPARK = `${PID}/muse-spark-1.3-contributor`;
  const DEEP = `${PID}/deepseek-v4.1-flash`;
  const session = captured.session;
  let pass = 0;
  let total = 0;

  function check(name, cond, extra = "") {
    total++;
    console.log(cond ? `PASS ${name}` : `FAIL ${name} ${extra}`);
    if (cond) pass++;
  }
  const tick = () => new Promise((r) => setTimeout(r, 50));
  const start = (id, model) => session.emit({ type: "session.compaction_start", data: { compactionAttemptId: id, model } });
  const done = (id, data) => session.emit({ type: "session.compaction_complete", data: { compactionAttemptId: id, ...data } });

  await start("a1", SPARK);
  await done("a1", { success: false, error: "400 only auto is supported for tool_choice" });
  await tick();
  check("switch-on-failure", session._models.length === 1 && session._models[0].model === DEEP, JSON.stringify(session._models));

  await start("a2", DEEP);
  await done("a2", { success: false, error: "boom" });
  await tick();
  check("no-double-switch", session._models.length === 1, JSON.stringify(session._models));

  await start("a3", DEEP);
  await done("a3", { success: true, model: DEEP });
  await tick();
  check("restore-on-success", session._models.length === 2 && session._models[1].model === SPARK, JSON.stringify(session._models));

  await start("a4", "openai/gpt-xyz");
  await done("a4", { success: false, error: "x" });
  await tick();
  check("ignore-foreign-model", session._models.length === 2, JSON.stringify(session._models));

  await start("a5", SPARK);
  await done("a5", { success: false, error: "x" });
  await tick();
  const n5 = session._models.length;
  await done("a6", { success: true, model: `${PID}/mimo-v2.6-pro` });
  await tick();
  check("stand-down-on-foreign-success", session._models.length === n5, JSON.stringify(session._models));

  session._models.length = 0;
  session._rejectFull = true;
  await start("a7", SPARK);
  await done("a7", { success: false, error: "x" });
  await tick();
  check("short-form-fallback", session._models.length === 1 && session._models[0].model === "deepseek-v4.1-flash", JSON.stringify(session._models));
  session._rejectFull = false;

  session._models.length = 0;
  await done("a8", { success: true, model: DEEP });
  await tick();
  const n7 = session._models.length;
  await captured.config.hooks.onErrorOccurred({ errorContext: "model_call", error: "Compaction failed badly" });
  await tick();
  check("error-hook-switch", session._models.length === n7 + 1 && session._models.at(-1).model === DEEP, JSON.stringify(session._models));

  const n8 = session._models.length;
  await captured.config.hooks.onErrorOccurred({ errorContext: "model_call", error: "plain model error" });
  await tick();
  check("error-hook-ignore", session._models.length === n8, JSON.stringify(session._models));

  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
