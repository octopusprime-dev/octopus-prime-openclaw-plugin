/**
 * Tap-to-answer (1.33.0): an agent's structured question (OpenClaw's
 * `ask_user`) and an agent's buttons and selects (its message presentation's
 * `buttons` and `select` blocks), sent to Octopus Prime as `ask` beside the
 * reply's words, so the apps draw them as chips people tap.
 *
 * - A question: `{ kind: "question", question_id, header?, text, options:
 *   [{ label, description? }], multi?, other?, expires_at? }`. Read from
 *   OpenClaw's own record of the pending question (its process-wide
 *   `Symbol.for("openclaw.askUserQuestions")` map: the questions, their
 *   options, several choices or one, and when it expires), else from the
 *   one-question presentation core builds for it (the question's words, its
 *   option buttons, "Other…"). A prompt of several questions stays words.
 * - Buttons: `{ kind: "buttons", text?, options: [{ label, url?, command?,
 *   style? }] }`. A link opens; a command button sends its command; any other
 *   button or select option sends its label as the person's message, which
 *   the agent gets as their reply (the button's callback value stays private).
 *
 * The rules are the backend's (backend/agent_questions.py), word for word: an
 * `ask` that breaks one is never sent. Only to a backend whose welcome offered
 * ASK_USER_CAPABILITY.
 *
 * An answer comes back as ANSWER_FRAME (one option of a single-choice
 * question, or the person's words for "Other…"), which the plugin resolves
 * through OpenClaw's question API (`openclaw/plugin-sdk/question-gateway-runtime`,
 * `resolveOption`, as Telegram's and Slack's buttons do), answering
 * RESULT_FRAME. Several choices and buttons come as the person's message
 * instead. When a question ends on the Gateway (answered anywhere, expired,
 * cancelled), CLOSED_FRAME tells the backend.
 */
import { resolveMessagePresentationButtonAction, resolveMessagePresentationOptionAction, } from "openclaw/plugin-sdk/interactive-runtime";
import { BLANK, codePoints, fail, has, Invalid, isObject, list, text, unique, } from "./presentation.js";
/** backend -> plugin: one answer to resolve on the Gateway. */
export const ANSWER_FRAME = "question.answer";
/** plugin -> backend: how resolving it went. */
export const RESULT_FRAME = "question.answer.result";
/** plugin -> backend: the question ended on the Gateway. */
export const CLOSED_FRAME = "question.closed";
export const ASK_STYLES = ["primary", "secondary", "success", "danger"];
export const ASK_LIMITS = Object.freeze({
    questionOptions: 8,
    buttonOptions: 25,
    header: 40,
    text: 2000,
    prompt: 200,
    label: 100,
    description: 500,
    url: 2000,
    command: 200,
    bytes: 8192,
});
const L = ASK_LIMITS;
const QUESTION_ID = /^ask_[a-f0-9]{32}$/;
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const COMMAND = /^\/[A-Za-z0-9_-]{1,64}( [^\r\n]+)?$/;
const LINK = /^https?:\/\/[^/?#]+/i;
function url(value) {
    const link = text(value, L.url);
    if (codePoints(link).some((code) => BLANK.has(code)) || !LINK.test(link))
        fail();
    return link;
}
function option(raw, kind) {
    if (!isObject(raw))
        fail();
    const kept = { label: text(raw.label, L.label) };
    if (kind === "question") {
        if (has(raw, "description"))
            kept.description = text(raw.description, L.description);
        return kept;
    }
    if (has(raw, "url") && has(raw, "command"))
        fail();
    if (has(raw, "url"))
        kept.url = url(raw.url);
    if (has(raw, "command")) {
        const command = text(raw.command, L.command);
        if (!COMMAND.test(command))
            fail();
        kept.command = command;
    }
    if (has(raw, "style")) {
        if (typeof raw.style !== "string" || !ASK_STYLES.includes(raw.style))
            fail();
        kept.style = raw.style;
    }
    return kept;
}
/** The compact UTF-8 size the backend counts, by code point. */
export function askSize(ask) {
    let bytes = 0;
    for (const char of JSON.stringify(ask)) {
        const code = char.codePointAt(0);
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
}
/**
 * The `ask` as the backend keeps it, or undefined when it breaks any rule (it
 * is then never sent). Unknown keys are dropped; strings are kept verbatim.
 */
export function askOf(raw) {
    try {
        if (!isObject(raw))
            fail();
        const kind = raw.kind;
        const kept = { kind };
        let options;
        if (kind === "question") {
            if (typeof raw.question_id !== "string" || !QUESTION_ID.test(raw.question_id))
                fail();
            kept.question_id = raw.question_id;
            if (has(raw, "header"))
                kept.header = text(raw.header, L.header);
            kept.text = text(raw.text, L.text);
            options = list(raw.options, 1, L.questionOptions);
        }
        else if (kind === "buttons") {
            if (has(raw, "text"))
                kept.text = text(raw.text, L.prompt);
            options = list(raw.options, 1, L.buttonOptions);
        }
        else {
            fail();
        }
        kept.options = options.map((entry) => option(entry, kind));
        unique(kept.options.map((entry) => entry.label));
        if (kind === "question") {
            for (const flag of ["multi", "other"]) {
                if (has(raw, flag)) {
                    if (typeof raw[flag] !== "boolean")
                        fail();
                    if (raw[flag])
                        kept[flag] = true;
                }
            }
            if (has(raw, "expires_at")) {
                if (typeof raw.expires_at !== "string" || !TIME.test(raw.expires_at))
                    fail();
                kept.expires_at = raw.expires_at;
            }
        }
        if (askSize(kept) > L.bytes)
            fail();
        return kept;
    }
    catch (error) {
        if (error instanceof Invalid)
            return undefined;
        throw error;
    }
}
/** The pending `ask_user` question a payload carries (core's `channelData.askUser`), by id. */
export function askUserQuestionId(payload) {
    const askUser = isObject(payload?.channelData) ? payload.channelData.askUser : undefined;
    const id = isObject(askUser) ? askUser.questionId : undefined;
    return typeof id === "string" && QUESTION_ID.test(id) ? id : undefined;
}
// OpenClaw's record of an ask_user question while it is pending, keyed by its
// id, in the Gateway process (core's src/agents/tools/ask-user-tool.ts). Read
// only, and only for what the prompt does not say: several choices or one,
// the option descriptions, and when it expires. A record of another shape is
// no record.
const ASK_USER_QUESTIONS = Symbol.for("openclaw.askUserQuestions");
function pendingQuestion(questionId) {
    const questions = globalThis[ASK_USER_QUESTIONS];
    if (!(questions instanceof Map))
        return undefined;
    const state = questions.get(questionId);
    if (!isObject(state) || !Array.isArray(state.questions) || state.questions.length === 0)
        return undefined;
    const first = state.questions[0];
    if (!isObject(first) || typeof first.question !== "string" || !Array.isArray(first.options))
        return undefined;
    const expires = typeof state.expiresAtMs === "number" && Number.isFinite(state.expiresAtMs) && state.expiresAtMs > 0
        ? state.expiresAtMs : undefined;
    return { question: first, count: state.questions.length, ...(expires ? { expiresAtMs: expires } : {}) };
}
// The question as the presentation core builds for a one-question prompt
// shows it (buildAgentHarnessQuestionPresentation): its words in the first
// text block, "- label: description" lines in the second, a button per option
// and "Other…" when free words are allowed.
function presentedQuestion(questionId, presentation) {
    if (!presentation || !Array.isArray(presentation.blocks))
        return undefined;
    const texts = presentation.blocks.filter((block) => block.type === "text");
    const buttons = presentation.blocks.filter((block) => block.type === "buttons");
    if (buttons.length !== 1 || texts.length === 0)
        return undefined;
    const options = [];
    let other = false;
    for (const button of buttons[0].buttons) {
        const action = isObject(button) && isObject(button.action) ? button.action : undefined;
        if (!action || action.type !== "question" || action.questionId !== questionId)
            continue;
        if (action.intent === "custom-input")
            other = true;
        else if (typeof action.optionValue === "string")
            options.push({ label: action.optionValue });
    }
    const guidance = typeof texts[1]?.text === "string" ? texts[1].text.split("\n") : [];
    for (const entry of options) {
        const line = guidance.find((candidate) => candidate.startsWith(`- ${entry.label}: `));
        if (line)
            entry.description = line.slice(`- ${entry.label}: `.length);
    }
    return { text: texts[0].text, options, ...(other ? { other: true } : {}) };
}
/**
 * The `ask` for an `ask_user` prompt: its one question as OpenClaw recorded
 * it, else as its presentation shows it; undefined for a prompt that is not
 * one, asks several questions, or would break a rule.
 */
export function questionAsk(payload, presentation) {
    const questionId = askUserQuestionId(payload);
    if (!questionId)
        return undefined;
    const pending = pendingQuestion(questionId);
    if (pending && pending.count !== 1)
        return undefined;
    let shape;
    if (pending) {
        const { question } = pending;
        shape = {
            header: question.header,
            text: question.question,
            options: question.options.map((entry) => (isObject(entry)
                ? { label: entry.label, ...(entry.description ? { description: entry.description } : {}) }
                : entry)),
            ...(question.multiSelect === true ? { multi: true } : {}),
            ...(question.isOther === true ? { other: true } : {}),
            ...(pending.expiresAtMs ? { expires_at: new Date(pending.expiresAtMs).toISOString() } : {}),
        };
    }
    else {
        shape = presentedQuestion(questionId, presentation ?? payload.presentation);
    }
    return shape ? askOf({ kind: "question", question_id: questionId, ...shape }) : undefined;
}
// A command as a person's message sends it: with its slash.
function slashed(command) {
    if (typeof command !== "string" || !command.trim())
        return undefined;
    const trimmed = command.trim();
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
/**
 * An agent's buttons and selects, out of its presentation: the `ask` they
 * make (links, commands and labels; approvals, question actions, disabled
 * buttons and web apps without a link stay in the words) and the
 * presentation without them. A label already taken is left out.
 */
export function splitControls(presentation) {
    const options = [];
    // Labels of controls the apps cannot act on (an approval, say): shown as
    // core shows controls a channel lacks, an "Actions:" context line.
    const kept = [];
    let prompt;
    const take = (entry) => {
        if (typeof entry.label !== "string" || options.some((taken) => taken.label === entry.label))
            return;
        options.push(entry);
    };
    const blocks = Array.isArray(presentation?.blocks) ? presentation.blocks : [];
    for (const block of blocks) {
        if (block.type === "buttons") {
            for (const button of block.buttons ?? []) {
                if (!isObject(button) || button.disabled === true)
                    continue;
                const action = resolveMessagePresentationButtonAction(button);
                const style = typeof button.style === "string" && ASK_STYLES.includes(button.style) ? { style: button.style } : {};
                const kind = action?.type;
                if (kind === "url" || (kind === "web-app" && typeof action?.url === "string"))
                    take({ label: button.label, url: action.url, ...style });
                else if (kind === "command" && slashed(action.command))
                    take({ label: button.label, command: slashed(action.command), ...style });
                else if (kind === "callback" || kind === undefined)
                    take({ label: button.label, ...style });
                else if (typeof button.label === "string")
                    kept.push(button.label);
            }
        }
        else if (block.type === "select") {
            prompt ??= typeof block.placeholder === "string" ? block.placeholder : undefined;
            for (const entry of block.options ?? []) {
                if (!isObject(entry))
                    continue;
                const action = resolveMessagePresentationOptionAction(entry);
                if (action?.type === "command" && slashed(action.command))
                    take({ label: entry.label, command: slashed(action.command) });
                else
                    take({ label: entry.label });
            }
        }
    }
    const rest = {
        ...presentation,
        blocks: [
            ...blocks.filter((block) => block.type !== "buttons" && block.type !== "select"),
            ...(kept.length ? [{ type: "context", text: `Actions:\n${kept.map((label) => `- ${label}`).join("\n")}` }] : []),
        ],
    };
    const ask = options.length ? askOf({ kind: "buttons", ...(prompt ? { text: prompt } : {}), options: options.slice(0, L.buttonOptions) }) : undefined;
    return { ...(ask ? { ask } : {}), rest };
}
/** The `ask` a payload's channelData carries for Octopus Prime, checked again, or undefined. */
export function channelDataAsk(channelData, key) {
    const own = isObject(channelData) ? channelData[key] : undefined;
    return isObject(own) && own.ask !== undefined ? askOf(own.ask) : undefined;
}
export function parseQuestionAnswer(raw) {
    const sender = raw.sender;
    if (raw.type !== ANSWER_FRAME ||
        typeof raw.message_id !== "string" || !raw.message_id || raw.message_id.length > 128 ||
        typeof raw.question_id !== "string" || !QUESTION_ID.test(raw.question_id) ||
        typeof raw.agent_id !== "string" || !raw.agent_id ||
        typeof raw.channel_id !== "string" || !raw.channel_id ||
        !isObject(sender) || typeof sender.id !== "string" || !sender.id ||
        typeof raw.answer !== "string" || !raw.answer.trim())
        return undefined;
    return {
        message_id: raw.message_id,
        question_id: raw.question_id,
        agent_id: raw.agent_id,
        channel_id: raw.channel_id,
        sender: { id: sender.id, ...(typeof sender.name === "string" ? { name: sender.name } : {}) },
        answer: raw.answer,
    };
}
/**
 * Resolves one answer through OpenClaw's question API: the option's label, or
 * the person's words for "Other…" (a question asked with ask_user always
 * takes them), resolved for the person as `octopus-prime:<their id>`.
 */
export async function resolveAnswer(frame, cfg, resolve) {
    try {
        const result = await resolve({
            cfg,
            questionId: frame.question_id,
            senderId: `octopus-prime:${frame.sender.id}`,
            optionValue: frame.answer,
            clientDisplayName: `Octopus Prime question (${frame.sender.name?.trim() || frame.sender.id})`,
        });
        if (result?.status === "answered")
            return "answered";
        if (result?.status === "already-terminal")
            return "closed";
        return "failed";
    }
    catch {
        return "failed";
    }
}
/** RESULT_FRAME for an answer. */
export function answerResultFrame(frame, status) {
    return { type: RESULT_FRAME, message_id: frame.message_id, question_id: frame.question_id, status };
}
/** How a question ended, from the status line core gives a channel's delivery of it. */
export function closedStatus(statusLine) {
    if (statusLine.startsWith("Answered"))
        return "answered";
    if (statusLine === "Expired")
        return "expired";
    return "cancelled";
}
/** CLOSED_FRAME for a question that ended on the Gateway. */
export function closedFrame(messageId, questionId, statusLine) {
    return { type: CLOSED_FRAME, message_id: messageId, question_id: questionId, status: closedStatus(statusLine) };
}
