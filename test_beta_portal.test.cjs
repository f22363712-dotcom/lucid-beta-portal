'use strict';
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {randomUUID} = require('node:crypto');
const {test} = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
const issued = {ok:true, inviteCode:'invite_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  downloadPageUrl:'https://www.wisdomprime.com/lucid/download', trialDays:7, dailyLimit:5};

// Run the shipped script. Only browser I/O is replaced; validation and submission stay real.
function portal(fetchImpl, initialCache = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const value = {value:'', textContent:'', disabled:false, href:'', style:{}, setAttribute(name, next) { this[name] = next; }};
      Object.defineProperty(value, 'innerText', {get() { return this.textContent; }, set(next) { this.textContent = next; }});
      elements.set(id, value);
    }
    return elements.get(id);
  };
  element('deviceModel').value = '荣耀 Magic6';
  element('systemVersion').value = 'Android 15';
  element('focusGoal').value = '刷考研真题';
  element('resultCard').style.display = 'none';
  const appInputs = ['哔哩哔哩', '抖音', '快手'].map((value, index) => ({value, checked:index < 2,
    parentElement:{classList:{add() {}, remove() {}}}}));
  const storage = new Map(Object.entries(initialCache));
  const listeners = new Map(), timers = new Map();
  let timerId = 0;
  const requests = [], copies = [];
  const context = vm.createContext({
    console:{log() {}, warn() {}}, AbortController, TypeError, crypto:{randomUUID},
    document:{getElementById:element, querySelectorAll(selector) {
      return selector.includes(':checked') ? appInputs.filter(input => input.checked) : appInputs;
    }},
    localStorage:{getItem:key => storage.get(key) ?? null, setItem:(key, value) => storage.set(key, value), removeItem:key => storage.delete(key)},
    navigator:{clipboard:{writeText:async value => { copies.push(value); }}},
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout:id => timers.delete(id),
    fetch:async (url, options) => { requests.push({url, options, body:JSON.parse(options.body)}); return fetchImpl(url, options); },
    scrollTo() {}, addEventListener:(name, callback) => listeners.set(name, callback)
  });
  context.window = context;
  vm.runInContext(script, context, {filename:'index.html'});
  return {element, requests, storage, copies, appInputs,
    submit:() => context.submitIntake({preventDefault() {}}),
    restore:() => listeners.get('DOMContentLoaded')?.(),
    copy:() => context.copyCode(),
    timeout:() => { for (const fn of [...timers.values()]) fn(); }};
}
const response = (body, status = 200) => new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json'}});
const remainsOnForm = app => {
  assert.notEqual(app.element('formCard').style.display, 'none');
  assert.equal(app.element('resultCard').style.display, 'none');
  assert.equal(app.element('codeSlot').innerText, '');
};

test('submission stays on the form until the server actually issues an invite', async () => {
  let finish;
  const app = portal(() => new Promise(resolve => { finish = resolve; }));
  const submitting = app.submit();
  remainsOnForm(app);
  assert.equal(app.element('btnSubmit').disabled, true);
  finish(response(issued));
  await submitting;
  assert.equal(app.element('codeSlot').innerText, issued.inviteCode);
  assert.equal(app.element('formCard').style.display, 'none');
  assert.equal(app.element('pgyerDownload').href, issued.downloadPageUrl);
  await app.copy();
  assert.deepEqual(app.copies, [issued.inviteCode]);
});

test('the server receives only the agreed questionnaire and a UUID', async () => {
  const app = portal(() => response(issued));
  await app.submit();
  const {url, body} = app.requests[0];
  assert.equal(url, 'https://www.wisdomprime.com/lucid/api/intake/');
  assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual({...body, requestId:'uuid'}, {requestId:'uuid', deviceModel:'荣耀 Magic6',
    systemVersion:'Android 15', apps:'哔哩哔哩, 抖音', focusGoal:'刷考研真题'});
});

for (const [name, status, body] of [
  ['HTTP failure with a success-looking body', 503, issued],
  ['old locally generated code', 200, {...issued, inviteCode:'LUCID-BETA-7D-XXXXX'}],
  ['untrusted download URL', 200, {...issued, downloadPageUrl:'https://attacker.example/download'}],
  ['download URL containing an invite', 200, {...issued, downloadPageUrl:issued.downloadPageUrl+'?inviteCode='+issued.inviteCode}],
  ['wrong response envelope', 200, {ok:true, code:issued.inviteCode}],
  ['server failure envelope', 200, {ok:false, error:{code:'intake_unavailable'}}],
  ['malformed JSON', 200, null]
]) test(name+' does not grant access or lose input', async () => {
  const app = portal(() => body === null ? new Response('{', {status}) : response(body, status));
  await app.submit();
  remainsOnForm(app);
  assert.equal(app.element('focusGoal').value, '刷考研真题');
  assert.equal(app.element('btnSubmit').disabled, false);
  assert.ok(app.element('intakeStatus').textContent);
  if (name === 'malformed JSON') assert.match(app.element('intakeStatus').textContent, /服务|重试/);
});

test('network retries reuse the same ID while changed answers receive a new ID', async () => {
  const app = portal(() => { throw new TypeError('offline'); });
  await app.submit();
  remainsOnForm(app);
  await app.submit();
  assert.equal(app.requests[1].body.requestId, app.requests[0].body.requestId);
  app.element('focusGoal').value = '整理错题';
  await app.submit();
  assert.notEqual(app.requests[2].body.requestId, app.requests[1].body.requestId);
});

test('a 20-per-day limit explains when to retry without showing an invite', async () => {
  const app = portal(() => response({ok:false, error:{code:'intake_budget_exceeded'}}, 429));
  await app.submit();
  remainsOnForm(app);
  assert.match(app.element('intakeStatus').textContent, /20/);
  assert.match(app.element('intakeStatus').textContent, /明天|次日/);
});

test('an IP or minute rate limit does not claim the global daily budget is gone', async () => {
  const app = portal(() => response({ok:false, error:{code:'rate_limited'}}, 429));
  await app.submit();
  remainsOnForm(app);
  assert.match(app.element('intakeStatus').textContent, /频繁|稍后/);
  assert.doesNotMatch(app.element('intakeStatus').textContent, /20 张|明天/);
});

test('timeout aborts the request and preserves the form for retry', async () => {
  const app = portal((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
  }));
  const submitting = app.submit();
  app.timeout();
  await submitting;
  remainsOnForm(app);
  assert.match(app.element('intakeStatus').textContent, /超时/);
  assert.equal(app.element('btnSubmit').disabled, false);
});

test('old code caches never restore a successful grant', () => {
  const app = portal(() => response(issued), {lucid_beta_user_record:JSON.stringify({code:'LUCID-BETA-7D-XXXXX'})});
  app.restore();
  remainsOnForm(app);
});

test('a valid server receipt restores the invite without reissuing it', async () => {
  const first = portal(() => response(issued));
  await first.submit();
  assert.ok(first.storage.size);
  const restored = portal(() => { throw new Error('restore must not request another invite'); }, Object.fromEntries(first.storage));
  restored.restore();
  assert.equal(restored.element('codeSlot').innerText, issued.inviteCode);
  assert.equal(restored.element('pgyerDownload').href, issued.downloadPageUrl);
  assert.equal(restored.requests.length, 0);
});

test('a receipt-expired response allows a new application with the same answers', async () => {
  let attempts = 0;
  const app = portal(() => ++attempts === 1
    ? response({ok:false, error:{code:'intake_receipt_expired'}}, 410) : response(issued));
  await app.submit();
  remainsOnForm(app);
  assert.match(app.element('intakeStatus').textContent, /过期|重新申请/);
  await app.submit();
  assert.notEqual(app.requests[0].body.requestId, app.requests[1].body.requestId);
  assert.equal(app.element('codeSlot').innerText, issued.inviteCode);
});

test('a seven-day-old cached invite returns to the form and retains the answers', () => {
  const cached = {version:2, receivedAt:Date.now()-7*86400000, receipt:issued,
    answers:{deviceModel:'vivo X100', systemVersion:'Android 14', apps:'快手', focusGoal:'整理错题'}};
  const app = portal(() => { throw new Error('expired cache must not issue automatically'); },
    {lucid_beta_server_invite_v2:JSON.stringify(cached)});
  app.restore();
  remainsOnForm(app);
  assert.equal(app.element('deviceModel').value, 'vivo X100');
  assert.equal(app.element('focusGoal').value, '整理错题');
  assert.deepEqual(app.appInputs.filter(input => input.checked).map(input => input.value), ['快手']);
  assert.match(app.element('intakeStatus').textContent, /过期|重新申请/);
  assert.equal(app.requests.length, 0);
});

test('a cached receipt without an issuance time cannot stay valid indefinitely', () => {
  const app = portal(() => response(issued), {lucid_beta_server_invite_v2:JSON.stringify({version:2, receipt:issued})});
  app.restore();
  remainsOnForm(app);
});
