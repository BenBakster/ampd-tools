import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// No browser or npm dependencies. Execute the actual inline calculation/rendering
// functions, with a small DOM adapter; compile every page script as well.
const files = ['index.html', 'full.html'];
const source = files.map(file => readFileSync(new URL(file, import.meta.url), 'utf8'));
const between = (s, a, b) => {
  const start = s.indexOf(a), end = s.indexOf(b, start);
  assert.ok(start >= 0 && end > start, `Missing section ${a}`);
  return s.slice(start, end);
};
function extract(s, name) {
  const match = s.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `Missing function ${name}`);
  return match[0];
}
const cores = source.map(s => between(s, '// BEGIN AMPD SCORING CORE', '// END AMPD SCORING CORE'));
assert.equal(cores[0], cores[1], 'Standalone calculation cores drifted');
for (const name of ['calc', 'buildTextReport', 'buildCompactReport', 'packResult', 'unpackResult']) {
  assert.equal(extract(source[0], name), extract(source[1], name), `${name} differs`);
}
const stripCommentLines = s => s.replace(/^[ \t]*\/\/.*\n/gm, '');
assert.equal(stripCommentLines(extract(source[0], 'sendToBot')), stripCommentLines(extract(source[1], 'sendToBot')));
const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const contexts = source.map((s, i) => {
  for (const script of s.matchAll(/<script(?:\s[^>]*)?>([^]*?)<\/script>/g)) {
    new vm.Script(script[1], { filename: files[i] });
  }
  const elements = {};
  const context = vm.createContext({
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-15T12:00:00Z'])); } },
    document: { getElementById(id) { return elements[id] ||= { value: '', style: {}, innerHTML: '', addEventListener() {} }; } },
    window: { __viewMode: true, scrollTo() {} },
    esc: escapeHTML, AMPD_BOT_ENDPOINT: '', curLang: 'uk',
    copyReport() {}, copyLink() {}, exportJSON() {}, sendToBot() {}, showSafetyModal() {},
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
  });
  vm.runInContext(cores[i] + '\nvar __report=null;\n' +
    ['calc','buildTextReport','buildCompactReport','packResult','unpackResult'].map(n => extract(s, n)).join('\n'), context);
  return {context, elements};
});
const json = value => JSON.stringify(value);
const clean = value => JSON.parse(json(value));
const answers = (n, value, offset = 0) => Object.fromEntries(Array.from({length:n}, (_,i) => [i+offset,value]));
const rev = [6,29,34,57,86,89,95,96,97,130,141,154,163,176,209,214];
const passport = {form:'LPFS-SR-80 + PID-5-220',norms:'LPFS-SR: Morey (N=306); PID-5: Markon et al. 2024 (N=995)',scoringVersion:'2.2.0',missingRule:'LPFS: complete components and total; PID-5: APA >=75% per facet; unrounded mean of answered items',normSample:{instrument:'PID-5-SRF',n:995,description:'US Census-matched'},respondentType:'self'};
function check(label, ansP, ansL = answers(80, 1, 1)) {
  const runs = contexts.map(({context: c, elements}) => {
    c.ansP = {...ansP}; c.ansL = {...ansL};
    c.document.getElementById('pid').value = 'Тест <&> Антон';
    const scores = c.calculateAMPD(c.ansL, c.ansP);
    c.calc();
    const text = c.buildTextReport(), compact = c.buildCompactReport(), html = elements.res.innerHTML;
    for (const output of [text,compact,html]) {
      assert.doesNotMatch(output, /NaN|undefined|null/, label);
      assert.ok(output.includes('2.2.0') && (output.includes(passport.missingRule) || output.includes(escapeHTML(passport.missingRule))), `${label}: missing passport`);
      assert.ok(output.includes('PID-5-BF+M') && output.includes('Ананкастія'), `${label}: missing BF+M`);
      for (const name of ['VRIN','ORS','PRD']) assert.ok(output.includes(name));
    }
    assert.ok(html.includes('Тест &lt;&amp;&gt; Антон'));
    const validP=Object.values(ansP).filter(v=>Number.isInteger(v)&&v>=0&&v<=3).length;
    const validL=Object.values(ansL).filter(v=>Number.isInteger(v)&&v>=1&&v<=4).length;
    const {instruments,...top}=clean(c.__report.passport);
    assert.deepEqual(top, {...passport,missingCount:300-validP-validL,missingCountByInstrument:{lpfs:80-validL,pid5:220-validP}});
    assert.equal(instruments.lpfs.normSample.n,306);assert.equal(instruments.pid5.normSample.n,995);
    assert.equal(instruments.lpfs.missingCount,80-validL);assert.equal(instruments.pid5.missingCount,220-validP);
    assert.equal(Object.keys(scores.pFS).length, 25);
    assert.equal(Object.keys(scores.pDS).length, 5);
    assert.equal(scores.bfM.domains.length, 6);
    for (const [name, items] of Object.entries(scores.FAC)) {
      const given = items.filter(id => ansP[id] !== undefined && ansP[id] !== null);
      const expected = given.length < Math.ceil(items.length * .75) ? null :
        given.reduce((s,id) => s + (rev.includes(id) ? 3-ansP[id] : ansP[id]),0) / given.length;
      assert.equal(scores.pFS[name], expected, `${label}: ${name}`);
      if (expected === null) assert.equal(scores.fT[name], null);
    }
    for (const [name, domain] of Object.entries(scores.DOM)) {
      const values = domain.f.map(f => scores.pFS[f]);
      const expected = values.includes(null) ? null : values.reduce((a,b)=>a+b,0)/3;
      assert.equal(scores.pDS[name], expected);
      if (expected === null) assert.equal(scores.dT[name], null);
    }
    for (const key of ['lSc','pFS','pDS','fT','dT','bfM']) assert.equal(json(c.__report[key]), json(scores[key]));
    // Legacy v1 payload and hash round-trip: omitted responses remain '-'.
    // null is normalized only for this legacy transport, whose format is unchanged.
    c.ansP = Object.fromEntries(Object.entries(ansP).filter(([,v]) => v != null));
    const packed = c.packResult(), restored = c.unpackResult(packed);
    const wire = Buffer.from(packed,'base64').toString('utf8').split('|');
    assert.equal(wire[0], 'v1'); assert.equal(wire[4].length,80); assert.equal(wire[5].length,220);
    assert.deepEqual(clean(restored.ansP), c.ansP);
    assert.deepEqual(clean(restored.ansL), Object.fromEntries(Object.entries(ansL).filter(([,v])=>Number.isInteger(v)&&v>=1&&v<=4)));
    return {scores,report:c.__report,text,compact,html,packed};
  });
  for (const key of ['lSc','pFS','pDS','fT','dT','vrinScore','orsScore','prdScore','bfM']) {
    assert.equal(json(runs[0].scores[key]),json(runs[1].scores[key]),`${label}: bit parity ${key}`);
  }
  for (const key of ['report','text','compact','html','packed']) assert.equal(json(runs[0][key]),json(runs[1][key]),`${label}: ${key}`);
  return clean(runs[0]);
}

// Five requested protocol groups (group 2 covers both constants and a mixed 1/2 protocol).
const zero = check('1. All zero', answers(220,0), answers(80,0,1));
assert.equal(zero.scores.pFS['Ангедонія'], .75);
assert.equal(zero.scores.pFS['Тривожність'], 1/3);
assert.equal(zero.scores.prdScore, 6);
assert.equal(zero.scores.lSc.Total, null);
assert.ok(Object.values(zero.scores.lSc).every(x=>x===null));
assert.ok(zero.text.includes("NA — NA"));
assert.ok(zero.compact.includes("⚪ Загальний бал — NA"));
assert.ok(zero.scores.bfM.domains.every(d => d.mean === 0));
console.log('PASS 1: all zero');
for (const n of [1,2]) {
  const r = check(`2. All ${n}`, answers(220,n), answers(80,n,1));
  assert.deepEqual(r.scores.lSc, {Identity:42.5*n,'Self-Direction':34.5*n,Empathy:25*n,Intimacy:38*n,Total:140*n});
  assert.equal(r.scores.vrinScore,0); assert.equal(r.scores.orsScore,0); assert.equal(r.scores.prdScore,18*n+6);
  assert.equal(r.scores.pFS['Безсердечність'], (13*n+3-n)/14);
  assert.equal(r.scores.fT['Безсердечність'], Math.round(50+10*(r.scores.pFS['Безсердечність']-.350)/.425));
  assert.equal(r.scores.dT['Психотизм'], Math.round(50+10*(n-.506)/.504));
  assert.ok(r.scores.bfM.domains.every(d => d.mean === n));
}
check('2. Alternating 1/2', Object.fromEntries(Array.from({length:220},(_,i)=>[i,1+i%2])));
console.log('PASS 2: all one, all two, mixed one/two');
const clinicalAnswers = answers(220,3);
const clinical = check('3. Clinical, high reverse responses', clinicalAnswers, answers(80,4,1));
assert.equal(clinical.scores.pFS['Ангедонія'], 18/8);
assert.equal(clinical.scores.pFS['Схильність до ризику'], 24/14);
assert.equal(clinical.scores.orsScore,10); assert.equal(clinical.scores.prdScore,60);
assert.ok(clinical.html.includes('3.00/3'));
console.log('PASS 3: clinical profile with high reverse responses');
const missingOne = answers(220,0); delete missingOne[29];
const single = check('4. Missing reverse item', missingOne);
assert.equal(single.scores.pFS['Ангедонія'], 3/7);
assert.notEqual(single.scores.pFS['Ангедонія'], 6/8);
const nullOne = {...missingOne,29:null};
assert.equal(check('4. Null reverse item', nullOne).scores.pFS['Ангедонія'],3/7);
console.log('PASS 4: omitted/null reverse item does not become 3');
const missingMany = {...missingOne}; delete missingMany[0]; delete missingMany[22];
const many = check('5. More than 25% missing', missingMany);
assert.equal(many.scores.pFS['Ангедонія'],null); assert.equal(many.scores.fT['Ангедонія'],null);
assert.equal(many.scores.pDS['Відстороненість'],null); assert.equal(many.scores.dT['Відстороненість'],null);
assert.ok(many.html.includes('T=NA')); assert.ok(many.compact.includes('NA (недостатньо відповідей)'));
console.log('PASS 5: >25% missing propagates NA to facet and domain');

// Boundary and key regressions prevent identical bugs in the two pages passing parity.
const boundary = {...missingOne}; delete boundary[0];
assert.equal(check('Exactly 75%',boundary).scores.pFS['Ангедонія'],3/6);
const smallFacet = answers(220,0); delete smallFacet[3];
assert.notEqual(check('5 of 6 items',smallFacet).scores.pFS['Імпульсивність'],null);
delete smallFacet[15];
assert.equal(check('4 of 6 items',smallFacet).scores.pFS['Імпульсивність'],null);
const bfKey = [ [[61,121],[108,109],[49,63]], [[81,135],[22,188],[88,107]], [[161,218],[125,217],[186,196]],
  [[128,159],[3,16],[5,131]], [[193,208],[24,184],[43,76]], [[122,175],[139,219],[33,114]] ];
const varied = Object.fromEntries(Array.from({length:220},(_,i)=>[i,(i*17+Math.floor(i/7))%4]));
const bf = check('BF+M independent item key',varied).scores.bfM;
assert.equal(new Set(bfKey.flat(2)).size,36);
bf.domains.forEach((d,i)=>{
  assert.deepEqual(d.facets.map(f=>f.items),bfKey[i]);
  const expected = bfKey[i].map(pair=>(varied[pair[0]]+varied[pair[1]])/2);
  assert.deepEqual(d.facets.map(f=>f.mean),expected);
  assert.equal(d.mean,expected.reduce((a,b)=>a+b,0)/3);
});
const bfMissing = answers(220,1); delete bfMissing[122];
assert.equal(check('BF+M missing subfacet',bfMissing).scores.bfM.domains[5].mean,null);
const invalidMissing = answers(220,1); delete invalidMissing[95]; delete invalidMissing[108]; delete invalidMissing[169];
const validity = check('Validity missing',invalidMissing);
for (const k of ['vrinScore','orsScore','prdScore']) assert.equal(validity.scores[k],null);
assert.doesNotMatch(validity.report.validityWarn,/PRD<11/);
const grayAnswers = answers(220,1);
for (const id of [78,108,101,137,37]) grayAnswers[id]=3;
for (const id of [79,49,147,88,73]) grayAnswers[id]=2;
const gray = check('VRIN gray zone',grayAnswers);
assert.equal(gray.scores.vrinScore,15); assert.equal(gray.report.valProb,true);
assert.ok(gray.html.includes('сіра зона'));
check('Empty PID-5',{});
for (const {context:c} of contexts) {
  for (const [t,color] of [[64,'#27ae60'],[65,'#f39c12'],[69,'#f39c12'],[70,'#e67e22'],[74,'#e67e22'],[75,'#c0392b'],[null,'#888']]) assert.equal(c.tcl(t),color);
  assert.equal(c.tsc(null,{m:1,sd:1}),null);
  assert.equal(c.tsc(1.45,{m:0,sd:1}),65);
}
console.log('PASS: APA boundaries, BF+M 36-item key, validity missing, T cutoffs, reports, v1 links, full script syntax');
console.log('All AMPD parity tests passed.');

const lpfsMissing=answers(80,1,1);delete lpfsMissing[4];
const partialLpfs=check('LPFS missing Identity item',answers(220,1),lpfsMissing);
assert.equal(partialLpfs.scores.lSc.Identity,null);assert.equal(partialLpfs.scores.lSc.Total,null);
assert.equal(partialLpfs.scores.lSc.Empathy,25);

// Telegram handoff: no auto-redirect; explicit link panel, copy, TTL expiry.
for (const name of ['showTgBox']) assert.equal(extract(source[0], name), extract(source[1], name), `${name} differs`);
for (const [i, s] of source.entries()) {
  for (const key of ['tgReady','openTg','copyTgLink','tgLinkCopied','tgHint','tgExpired']) {
    assert.equal(s.split(key + ':').length - 1, 2, `${files[i]}: ${key} must exist in uk and ru`);
  }
  assert.ok(s.includes('.tg-box{') && s.includes('.tg-open{'), `${files[i]}: tg-box CSS missing`);
  assert.doesNotMatch(s, /location\.href\s*=\s*dl/, `${files[i]}: auto-redirect is back`);
}
async function runSend(s, deepLink) {
  const nodes = {}, toasts = [], copied = [], timers = [];
  const mk = tag => {
    let own = '';
    const n = { tag, children: [], className: '', disabled: false, listeners: {},
      appendChild(c) { this.children.push(c); c.parentNode = this; if (c.id) nodes[c.id] = c; return c; },
      addEventListener(t, f) { this.listeners[t] = f; }, scrollIntoView() {} };
    Object.defineProperty(n, 'textContent', {
      get() { return own + n.children.map(c => c.textContent).join(''); },
      set(v) { own = v; n.children = []; } });
    return n;
  };
  const row = mk('div'), btn = mk('button'); btn.id = 'btnBot'; row.appendChild(btn);
  const loc = { href: 'https://example.test/ampd/' };
  const lb = { sending: 's', errPrefix: 'E:', endpointMissing: 'm', encodeErr: 'e', tgReady: 'READY', openTg: 'OPEN',
    copyTgLink: 'COPY', tgLinkCopied: 'COPIED', tgHint: 'HINT', tgExpired: 'EXPIRED' };
  const c = vm.createContext({
    document: { getElementById: id => nodes[id] || null, createElement: mk },
    window: { location: loc }, location: loc, UI: { uk: lb }, curLang: 'uk', AMPD_BOT_ENDPOINT: 'https://bot.test/ampd/submit',
    packResult: () => 'QUJD', sanitizeName: x => x, buildCompactReport: () => 'r', buildTextReport: () => 'r', buildHtmlReport: () => '',
    showToast: m => toasts.push(m), copyText: (t, ok) => { copied.push(t); ok(); },
    setTimeout: (f, ms) => (timers.push({ f, ms }), timers.length), clearTimeout() {},
    fetch: async () => ({ ok: true, json: async () => ({ token: 'abc', deep_link: deepLink }) }),
  });
  vm.runInContext(s.match(/^var AMPD_DEEP_LINK_RE=.*$/m)[0] + '\n' + s.match(/^var AMPD_LINK_TTL_MS=.*$/m)[0] + '\n' +
    extract(s, 'showTgBox') + '\n' + extract(s, 'sendToBot'), c);
  c.sendToBot();
  for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
  return { nodes, btn, row, loc, toasts, copied, timers };
}
for (const [i, s] of source.entries()) {
  const dl = 'https://t.me/vilenchyk_bot?start=ampd_abc';
  const ok = await runSend(s, dl);
  assert.equal(ok.loc.href, 'https://example.test/ampd/', `${files[i]}: page must not navigate away`);
  const box = ok.nodes.tgBox;
  assert.ok(box && box.parentNode === ok.row && box.className === 'tg-box', `${files[i]}: tg box not shown inside .btns`);
  const act = box.children.find(n => n.className === 'tg-act');
  const a = act.children.find(n => n.tag === 'a');
  assert.equal(a.href, dl); assert.equal(a.target, '_blank'); assert.equal(a.rel, 'noopener');
  assert.ok(box.textContent.includes('READY') && box.textContent.includes('HINT'));
  assert.equal(ok.btn.disabled, true, `${files[i]}: resend must be blocked while link is live`);
  act.children.find(n => n.tag === 'button').listeners.click();
  assert.deepEqual(ok.copied, [dl]); assert.ok(ok.toasts.includes('COPIED'));
  assert.equal(ok.timers.length, 1); assert.equal(ok.timers[0].ms, 59 * 60 * 1000);
  ok.timers[0].f();
  assert.equal(box.className, 'tg-box expired'); assert.equal(box.textContent, 'EXPIRED');
  assert.equal(ok.btn.disabled, false, `${files[i]}: resend must be possible after expiry`);
  const bad = await runSend(s, 'javascript:alert(1)');
  assert.equal(bad.nodes.tgBox, undefined); assert.equal(bad.btn.disabled, false);
  assert.ok(bad.toasts.includes('E:bad_deep_link')); assert.equal(bad.loc.href, 'https://example.test/ampd/');
}
console.log('PASS: Telegram handoff panel (no redirect, copy link, 59-min expiry, bad deep_link rejected)');
