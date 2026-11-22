'use strict';
// wasm.cjs: a small WebAssembly assembler, so that fast.cjs can write its reader as structured code (named locals,
// globals, loops and blocks) and get the module's bytes at run time. Only what fast.cjs uses is here.
//
// A node is an array of bytes or a function (cx, out) that appends its bytes to `out`, cx resolving names (locals,
// globals, functions, labels). A list of nodes is a sequence of instructions. Everything appends to one array:
// assembling runs once per process, so it is kept cheap.

const I32 = 0x7f;
const I64 = 0x7e;
const V128 = 0x7b;

function uleb(n, out = []) {
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

function sleb(v, out = []) {
  // Values here fit 32 bits.
  let x = v | 0;
  for (;;) {
    const b = x & 0x7f;
    x >>= 7;
    if ((x === 0 && (b & 0x40) === 0) || (x === -1 && (b & 0x40) !== 0)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

const str = (s) => {
  const b = [...Buffer.from(s, 'utf8')];
  return [...uleb(b.length), ...b];
};
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => (body.length === 0 ? [] : [id, ...uleb(body.length), ...body]);

function emit(node, cx, out) {
  if (typeof node === 'function') node(cx, out);
  else for (let i = 0; i < node.length; i++) out.push(node[i]);
}
function seq(nodes, cx, out) {
  for (let i = 0; i < nodes.length; i++) emit(nodes[i], cx, out);
}

// Values.
const get = (n) => (cx, out) => uleb(cx.local(n), (out.push(0x20), out));
const set = (n, e) => (cx, out) => {
  emit(e, cx, out);
  out.push(0x21);
  uleb(cx.local(n), out);
};
const tee = (n, e) => (cx, out) => {
  emit(e, cx, out);
  out.push(0x22);
  uleb(cx.local(n), out);
};
const gget = (n) => (cx, out) => uleb(cx.global(n), (out.push(0x23), out));
const gset = (n, e) => (cx, out) => {
  emit(e, cx, out);
  out.push(0x24);
  uleb(cx.global(n), out);
};
const c = (v) => [0x41, ...sleb(v)];
const vconst = (bytes16) => [0xfd, 0x0c, ...bytes16];

// (Indexed loops throughout: this runs once, cold, in the interpreter, where for...of costs.)
const pushAll = (out, bytes) => {
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
};
const op1 = (...code) => (a) => (cx, out) => {
  emit(a, cx, out);
  pushAll(out, code);
};
const op2 = (...code) => (a, b) => (cx, out) => {
  emit(a, cx, out);
  emit(b, cx, out);
  pushAll(out, code);
};

// i32
const add = op2(0x6a);
const sub = op2(0x6b);
const mul = op2(0x6c);
const divU = op2(0x6e);
const remU = op2(0x70);
const and = op2(0x71);
const or = op2(0x72);
const xor = op2(0x73);
const shl = op2(0x74);
const shrU = op2(0x76);
const eqz = op1(0x45);
const eq = op2(0x46);
const ne = op2(0x47);
const lt = op2(0x48); // signed
const gt = op2(0x4a);
const le = op2(0x4c);
const ge = op2(0x4e);
const ltU = op2(0x49);
const clz = op1(0x67);
const ctz = op1(0x68);
const popcnt = op1(0x69);
const select = (a, b, cond) => (cx, out) => {
  emit(a, cx, out);
  emit(b, cx, out);
  emit(cond, cx, out);
  out.push(0x1b);
};

// Memory (unaligned accesses are fine in wasm: the alignment hint is 0 everywhere).
const mem = (opcode) => (a, off = 0) => (cx, out) => {
  emit(a, cx, out);
  pushAll(out, opcode);
  out.push(0);
  uleb(off, out);
};
const memSt = (opcode) => (a, v, off = 0) => (cx, out) => {
  emit(a, cx, out);
  emit(v, cx, out);
  pushAll(out, opcode);
  out.push(0);
  uleb(off, out);
};
const ld8 = mem([0x2d]);
const ld32 = mem([0x28]);
const vld = mem([0xfd, 0x00]);
const st8 = memSt([0x3a]);
const st32 = memSt([0x36]);
const vst = memSt([0xfd, 0x0b]);
// Copies len bytes (memory.copy, bulk memory).
const mcopy = (dst, src, len) => (cx, out) => {
  emit(dst, cx, out);
  emit(src, cx, out);
  emit(len, cx, out);
  out.push(0xfc, 0x0a, 0, 0);
};

// v128 (i8x16)
const splat8 = op1(0xfd, 0x0f);
const veq8 = op2(0xfd, 0x23);
const vltU8 = op2(0xfd, 0x26);
const vor = op2(0xfd, 0x50);
const vand = op2(0xfd, 0x4e);
const vbitmask8 = op1(0xfd, 0x64);
const vswizzle = op2(0xfd, 0x0e);

// Control. Labels are named; `null` names the label an `if` opens.
const label = (cx, out, name, body) => {
  cx.labels.push(name);
  seq(body, cx, out);
  cx.labels.pop();
};
const depth = (cx, name) => {
  const i = cx.labels.lastIndexOf(name);
  if (i < 0) throw new Error(`no label ${name}`);
  return cx.labels.length - 1 - i;
};
const If = (cond, then, els) => (cx, out) => {
  emit(cond, cx, out);
  out.push(0x04, 0x40);
  label(cx, out, null, then);
  if (els) {
    out.push(0x05);
    label(cx, out, null, els);
  }
  out.push(0x0b);
};
const Block = (name, body) => (cx, out) => {
  out.push(0x02, 0x40);
  label(cx, out, name, body);
  out.push(0x0b);
};
const Loop = (name, body) => (cx, out) => {
  out.push(0x03, 0x40);
  label(cx, out, name, body);
  out.push(0x0b);
};
const Br = (name) => (cx, out) => uleb(depth(cx, name), (out.push(0x0c), out));
const BrIf = (name, cond) => (cx, out) => {
  emit(cond, cx, out);
  out.push(0x0d);
  uleb(depth(cx, name), out);
};
// while (cond) body: Continue(name) tests cond again, Break(name) leaves.
const While = (name, cond, body) => Block(`${name}!`, [Loop(name, [BrIf(`${name}!`, eqz(cond)), ...body, Br(name)])]);
const Continue = (name) => Br(name);
const Break = (name) => Br(`${name}!`);
// for (;;) body: Continue(name) goes round again, Break(name) leaves.
const Forever = (name, body) => Block(`${name}!`, [Loop(name, [...body, Br(name)])]);
const Ret = (e) => (cx, out) => {
  if (e !== undefined) emit(e, cx, out);
  out.push(0x0f);
};
const call = (name, ...args) => (cx, out) => {
  seq(args, cx, out);
  out.push(0x10);
  uleb(cx.func(name), out);
};
const drop = (e) => (cx, out) => {
  emit(e, cx, out);
  out.push(0x1a);
};

/**
 * The module's bytes. spec: {memory: {module, name, pages}, imports: [{module, name, params, result}],
 * globals: [[name, initial]] (mutable i32), funcs: [{name, params: [[n, t]], result, locals: [[n, t]], body,
 * export}]}.
 */
function assemble(spec) {
  const types = [];
  const typeOf = (params, result) => {
    const t = [0x60, ...vec(params.map((p) => [p])), ...vec(result == null ? [] : [[result]])];
    const key = t.join(',');
    let i = types.findIndex((x) => x.join(',') === key);
    if (i < 0) i = types.push(t) - 1;
    return i;
  };
  const funcIndex = new Map();
  spec.imports.forEach((f, i) => funcIndex.set(f.name, i));
  spec.funcs.forEach((f, i) => funcIndex.set(f.name, spec.imports.length + i));
  const globalIndex = new Map(spec.globals.map(([n], i) => [n, i]));

  const imports = [
    [...str(spec.memory.module), ...str(spec.memory.name), 0x02, 0x01, ...uleb(spec.memory.pages), ...uleb(spec.memory.pages)],
    ...spec.imports.map((f) => [...str(f.module), ...str(f.name), 0x00, ...uleb(typeOf(f.params, f.result))]),
  ];
  const funcTypes = spec.funcs.map((f) => uleb(typeOf(f.params.map((p) => p[1]), f.result)));
  const globals = spec.globals.map(([, v]) => [I32, 0x01, ...c(v), 0x0b]);
  const exports = spec.funcs.filter((f) => f.export).map((f) => [...str(f.name), 0x00, ...uleb(funcIndex.get(f.name))]);
  const codes = spec.funcs.map((f) => {
    const names = new Map([...f.params, ...f.locals].map(([n], i) => [n, i]));
    const cx = {
      labels: [],
      local: (n) => {
        const i = names.get(n);
        if (i === undefined) throw new Error(`${f.name}: no local ${n}`);
        return i;
      },
      global: (n) => {
        const i = globalIndex.get(n);
        if (i === undefined) throw new Error(`${f.name}: no global ${n}`);
        return i;
      },
      func: (n) => {
        const i = funcIndex.get(n);
        if (i === undefined) throw new Error(`${f.name}: no function ${n}`);
        return i;
      },
    };
    const body = vec(f.locals.map(([, t]) => [1, t]));
    seq(f.body, cx, body);
    if (f.result != null) body.push(0x00);
    body.push(0x0b);
    return [...uleb(body.length), ...body];
  });
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(2, vec(imports)),
    ...section(3, vec(funcTypes)),
    ...section(6, vec(globals)),
    ...section(7, vec(exports)),
    ...section(10, vec(codes)),
  ]);
}

module.exports = {
  I32, I64, V128, assemble,
  get, set, tee, gget, gset, c, vconst,
  add, sub, mul, divU, remU, and, or, xor, shl, shrU, eqz, eq, ne, lt, gt, le, ge, ltU, clz, ctz, popcnt, select,
  ld8, st8, ld32, st32, vld, vst, mcopy,
  splat8, veq8, vltU8, vor, vand, vbitmask8, vswizzle,
  If, Block, Loop, Br, BrIf, While, Continue, Break, Forever, Ret, call, drop,
};
