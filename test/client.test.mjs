import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/**
 * 客户端半边（lib/client.js）的回归测试（评审 P1-7）。
 *
 * 它是浏览器经典脚本，只做三件事：把自己交给 __ModuleLoader__、注册三个座席、
 * 打开中栏 iframe。之前完全没有测试，所以座席名/序号/组件形态一律按实现钉住。
 * 注意：组件是函数（不是元素），要 comp() 之后才有 props。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function loadClient(baseURI) {
  const captured = [];
  const warnings = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (reg) => captured.push(reg) } },
    document: { baseURI: baseURI === undefined ? 'http://127.0.0.1:61403/' : baseURI },
    console: { warn: (...a) => warnings.push(a.map(String).join(' ')), log() {}, error() {} },
    URL,
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' });
  assert.equal(captured.length, 1, 'the client must register exactly one module');
  return { reg: captured[0], warnings };
}

function fakeReact(elements) {
  return {
    createElement: (type, props, ...children) => {
      const el = { type, props: props || {}, children };
      elements.push(el);
      return el;
    },
  };
}

function fakeRequire(elements) {
  const React = fakeReact(elements);
  return () => React;
}

function fakeSlots() {
  const state = { injected: [], regs: [], offs: 0 };
  const slots = {
    inject(name, cb) {
      state.injected.push(name);
      cb();
      return () => { state.offs += 1; };
    },
    register(sel, comp) {
      state.regs.push({ sel, comp });
      return () => { state.offs += 1; };
    },
  };
  return { slots, state };
}

function clientOf(elements) {
  const { reg } = loadClient();
  return reg.factory(fakeRequire(elements));
}

test('the client registers one module under the ids the web loader expects', () => {
  const { reg } = loadClient();
  assert.equal(reg.id, 'polaris-toolkit');
  assert.equal(pkg.dsh.client.platform, 'web');
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes('insert:'), 'cordis.patch.yml must insert the plugin');
  assert.ok(patch.includes('polaris-toolkit'), 'cordis.patch.yml must name polaris-toolkit');
  const mod = reg.factory(fakeRequire([]));
  assert.equal(typeof mod.apply, 'function');
  assert.ok(Array.isArray(mod.inject), 'module inject must be an array');
  assert.equal(mod.inject.length, 0, 'client inject stays empty; slots are awaited via ctx.inject');
});

test('apply registers three seats and the panel iframe on the plugin prefix', () => {
  const { slots, state } = fakeSlots();
  const selected = [];
  const effects = [];
  const mod = clientOf([]);
  mod.apply({ slots, layout: { selectPanel: (id) => selected.push(id) }, effect: (fn, label) => effects.push({ off: fn(), label }) });
  assert.equal(state.injected.length, 3);
  assert.equal(state.injected[0], 'sidebar.panellist');
  assert.equal(state.injected[1], 'main');
  assert.equal(state.injected[2], 'conversation.session.header.utilities');
  assert.equal(state.regs.length, 3);
  const sidebar = state.regs[0].sel;
  assert.equal(sidebar.name, 'sidebar.panellist');
  assert.equal(sidebar.id, 'polaris-toolkit');
  assert.equal(sidebar.order, 95);
  assert.equal(sidebar.label(), 'Polaris Toolkit');
  const glyph = state.regs[0].comp();
  assert.equal(glyph.type, 'svg');
  assert.equal(state.regs[1].sel.name, 'main');
  assert.equal(state.regs[1].sel.key, 'polaris-toolkit');
  const frame = state.regs[1].comp();
  assert.equal(frame.type, 'iframe');
  assert.equal(frame.props.src, 'http://127.0.0.1:61403/__polaris/panel');
  assert.equal(frame.props.title, 'Polaris Toolkit');
  assert.equal(state.regs[2].sel.name, 'conversation.session.header.utilities');
  const chip = state.regs[2].comp();
  assert.equal(chip.type, 'button');
  assert.equal(typeof chip.props.onClick, 'function');
  chip.props.onClick();
  assert.equal(selected.length, 1);
  assert.equal(selected[0], 'polaris-toolkit');
  assert.equal(effects.length, 1);
  assert.equal(effects[0].label, 'polaris-toolkit: client slots');
  assert.equal(typeof effects[0].off, 'function', 'effect must return the disposer');
  effects[0].off();
  assert.equal(state.offs, 3, 'every seat disposer must run on cleanup');
});

test('apply waits for the slots service through ctx.inject', () => {
  const { slots, state } = fakeSlots();
  let injectedNames;
  const mod = clientOf([]);
  mod.apply({
    inject: (names, cb) => {
      injectedNames = names;
      cb({ slots, effect() {} });
    },
    layout: { selectPanel() {} },
    effect() {},
  });
  assert.equal(injectedNames.length, 1);
  assert.equal(injectedNames[0], 'slots');
  assert.equal(state.regs.length, 3);
});

test('a missing slots service only warns, it never throws', () => {
  const { reg, warnings } = loadClient();
  const mod = reg.factory(fakeRequire([]));
  assert.doesNotThrow(() => mod.apply({ slots: {}, layout: { selectPanel() {} }, effect() {} }));
  assert.doesNotThrow(() => mod.apply({}));
  assert.ok(warnings.some((w) => w.includes('slots service unavailable')), 'expected a slots warning, got: ' + warnings.join(' | '));
  assert.ok(warnings.some((w) => w.includes('neither ctx.inject nor ctx.slots')), 'expected a service warning, got: ' + warnings.join(' | '));
});

test('a broken document.baseURI falls back to the absolute plugin path', () => {
  const { reg } = loadClient('not a url');
  const mod = reg.factory(fakeRequire([]));
  const { slots, state } = fakeSlots();
  mod.apply({ slots, layout: { selectPanel() {} }, effect() {} });
  const frame = state.regs[1].comp();
  assert.equal(frame.props.src, '/__polaris/panel');
});

test('a throwing seat cannot abort the others', () => {
  const { slots, state } = fakeSlots();
  const original = slots.inject;
  slots.inject = (name, cb) => {
    if (name === 'main') throw new Error('seat exploded');
    return original(name, cb);
  };
  const mod = clientOf([]);
  assert.doesNotThrow(() => mod.apply({ slots, layout: { selectPanel() {} }, effect() {} }));
  assert.equal(state.regs.length, 2, 'the two healthy seats must still register');
});
