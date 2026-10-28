// The example page. Plain JavaScript, no framework. Every value from the visitor
// or from Claude is written with textContent, never innerHTML.
import { createByokClaude, formatUsd } from "/dist/browser/claude-byok.js";

const claude = createByokClaude({
  models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  maxTokens: 4096,
  sessionBudgetUsd: 0.5,
  effort: "low",
  allowRememberKey: true,
  system: "Answer briefly and clearly, in plain text without Markdown.",
});

const $ = (id) => document.getElementById(id);
const keyForm = $("key-form");
const keyInput = $("key");
const remember = $("remember");
const askForm = $("ask-form");
const question = $("question");
const model = $("model");
const askButton = $("ask");
const stopButton = $("stop");
const answer = $("answer");
const notice = $("notice");
const errorBox = $("error");
const cost = $("cost");

let current = null;
let lastCost = null;

$("limit").textContent = formatUsd(claude.getState().budget.limitUsd);
$("cap").textContent = claude.maxTokens.toLocaleString();
$("remember-row").hidden = !claude.getState().canRememberKey;
for (const id of claude.models) {
  model.append(new Option(id, id));
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = message === "";
}

function render() {
  const state = claude.getState();
  keyForm.hidden = state.hasKey;
  $("key-set").hidden = !state.hasKey;
  $("key-status").textContent = state.keyRemembered
    ? "Key set. It's remembered on this device until you forget it."
    : "Key set. It's held in this tab's memory only and is gone when you close it.";
  askButton.disabled = !state.hasKey || state.busy;
  stopButton.hidden = !state.busy;

  const { spentUsd, limitUsd, reservedUsd } = state.budget;
  const parts = [];
  if (lastCost !== null) parts.push(`Last answer: ${formatUsd(lastCost)}`);
  parts.push(`This session: ${formatUsd(spentUsd)} of ${formatUsd(limitUsd)} spent`);
  if (reservedUsd > 0) parts.push(`up to ${formatUsd(reservedUsd)} held for the answer in progress`);
  cost.textContent = parts.join(" · ");
}

claude.subscribe(render);
render();

keyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    claude.setKey(keyInput.value, { remember: remember.checked });
    showError("");
  } catch (error) {
    showError(error.message);
  } finally {
    // Don't leave the key sitting in the form.
    keyInput.value = "";
  }
});

$("forget").addEventListener("click", () => {
  claude.forgetKey();
  remember.checked = false;
  showError("");
});

stopButton.addEventListener("click", () => {
  current?.abort();
});

askForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  current?.abort();
  current = new AbortController();
  answer.textContent = "";
  notice.hidden = true;
  showError("");
  try {
    const result = await claude.ask({
      prompt: question.value,
      model: model.value,
      signal: current.signal,
      onText: (_delta, soFar) => {
        answer.textContent = soFar;
      },
    });
    answer.textContent = result.text;
    lastCost = result.costUsd;
    if (result.notice) {
      notice.textContent = result.notice;
      notice.hidden = false;
    }
  } catch (error) {
    showError(error.message);
  } finally {
    current = null;
    render();
  }
});
