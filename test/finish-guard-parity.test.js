import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../plugins/finish-guard.js";
const session = events => ({ seq: events.length, eventAt: i => events[i] });
const user = text => ({type:"user/message", data:{source:{kind:"user"},content:[{type:"text",text}]}});
const reply = text => ({type:"assistant/message",data:{message:{content:[{type:"text",text}]}}});
const todos = list => ({type:"todo/write",data:{todos:list}});
const harness = config => { const handlers = {}; apply({on:(name, fn)=>{handlers[name]=fn;}}, config); return handlers["agent/turn-stopping"]; };

test("guard handles questions, precise blockers and missing phrase through the hook", () => {
  const invoke = (request, answer, list = []) => {
    const events = [{ type: "turn/start", data: { turn: 1 } }, user(request), todos(list), reply(answer)];
    const pushed = [];
    harness({})({ agent: { session: session(events), steer: m => pushed.push(m) }, turn: 1, signal: { aborted: false } });
    return pushed.length;
  };
  assert.equal(invoke("Explain what is still not done?", "It is still not done."), 0);
  assert.equal(invoke("Can you fix it?", "Remaining items: bug"), 1);
  assert.equal(invoke("Please HOLD", "Remaining items: bug"), 0);
  assert.equal(invoke("Fix it", "One gap I'm fixing now"), 1);
  assert.equal(invoke("Fix it", "Done", [{content:"work",status:"blocked",reason:"approval tests fail"}]), 1);
  assert.equal(invoke("Fix it", "Done", [{content:"work",status:"blocked",reason:"operator approval required"}]), 0);
});
