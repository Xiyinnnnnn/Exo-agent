/**
 * validate_multi.js — 多语言真解析校验器 v3.1（官方 web-tree-sitter API）
 *
 * 【能力】14 种主流语言语法真解析（tree-sitter AST）: js/ts/tsx/py/java/go/c/cpp/csharp/rust/ruby/php/json/bash
 * 【原理】加载官方 web-tree-sitter@0.24.7 glue（自带 WASI imports/PIC 初始化/回调注册），
 *        用官方 Parser/Language API 解析，错误节点(isError/isMissing)遍历定位行列。
 * 【调用协议】
 *   ① filesystem create /tmp/_validate_target.<ext>   ← 待校验源码(扩展名决定语言)
 *   ② code_runner path="/downloads/validate_multi.js" timeout=60000
 *   ③ 解析 stdout JSON
 * 【输出】{tool,language,target,engine,syntax{ok,error,row,column},issues[],static[],summary,verdict}
 *   verdict: errors>0→FAIL | warnings>0→WARN | PASS
 */
'use strict';
const fs = require('fs');

/* ============ 配置 ============ */
const GLUE_URL = 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.24.7/tree-sitter.js';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.24.7/tree-sitter.wasm';
const TMP_DIR = '/tmp';
const RESULT_FILE = '/sandbox/_validate_multi_result.json';
const PREFIX = '_validate_target.';
const LANGS = {
  js: 'https://cdn.jsdelivr.net/npm/tree-sitter-javascript@0.23.1/tree-sitter-javascript.wasm',
  ts: 'https://cdn.jsdelivr.net/npm/tree-sitter-typescript@0.23.2/tree-sitter-typescript.wasm',
  tsx: 'https://cdn.jsdelivr.net/npm/tree-sitter-typescript@0.23.2/tree-sitter-tsx.wasm',
  py: 'https://cdn.jsdelivr.net/npm/tree-sitter-python@0.23.6/tree-sitter-python.wasm',
  java: 'https://cdn.jsdelivr.net/npm/tree-sitter-java@0.23.5/tree-sitter-java.wasm',
  go: 'https://cdn.jsdelivr.net/npm/tree-sitter-go@0.23.4/tree-sitter-go.wasm',
  c: 'https://cdn.jsdelivr.net/npm/tree-sitter-c@0.23.4/tree-sitter-c.wasm',
  cpp: 'https://cdn.jsdelivr.net/npm/tree-sitter-cpp@0.23.4/tree-sitter-cpp.wasm',
  cs: 'https://cdn.jsdelivr.net/npm/tree-sitter-c-sharp@0.23.1/tree-sitter-c_sharp.wasm',
  rs: 'https://cdn.jsdelivr.net/npm/tree-sitter-rust@0.23.2/tree-sitter-rust.wasm',
  rb: 'https://cdn.jsdelivr.net/npm/tree-sitter-ruby@0.23.1/tree-sitter-ruby.wasm',
  php: 'https://cdn.jsdelivr.net/npm/tree-sitter-php@0.23.11/tree-sitter-php.wasm',
  json: 'https://cdn.jsdelivr.net/npm/tree-sitter-json@0.24.8/tree-sitter-json.wasm',
  sh: 'https://cdn.jsdelivr.net/npm/tree-sitter-bash@0.23.3/tree-sitter-bash.wasm',
};

/* ============ 安全规则（静态补充，tree-sitter 负责语法真解析） ============ */
const SAFETY_RULES = {
  js: [
    { id: 'FORBIDDEN_REQUIRE', level: 'error', pattern: /require\s*\(\s*['"](?:http|https|child_process|net|tls|dgram|cluster|worker_threads|vm)['"]\s*\)/g, msg: '沙箱无此模块，应改用 fetch()/沙箱内置模块' },
    { id: 'FORBIDDEN_BUFFER', level: 'error', pattern: /\bBuffer\b/g, msg: '沙箱无 Buffer 全局' },
    { id: 'FORBIDDEN_PROCESS', level: 'warn', pattern: /\bprocess\s*\./g, msg: '沙箱无 process 全局，代码在 Node 外运行' },
    { id: 'DANGEROUS_EVAL', level: 'error', pattern: /\beval\s*\(/g, msg: 'eval 动态执行被禁用' },
    { id: 'DANGEROUS_NEW_FUNCTION', level: 'error', pattern: /new\s+Function\s*\(/g, msg: 'new Function 动态编译被禁用' },
    { id: 'RESTRICTED_PATH', level: 'error', pattern: /['"`](\/(?:config|memory|pipelines|trash)\/)/g, msg: '访问受限目录(沙箱不可见)' },
    { id: 'UPLOADS_WRITE', level: 'warn', pattern: /(?:write|append|unlink|rename)\w*\s*\([^)]*['"`]\/uploads\//g, msg: '/uploads 只读，写操作会失败' },
    { id: 'FS_OLD_API', level: 'error', pattern: /\bfs\.(?:read|write)\s*\(/g, msg: '沙箱无 fs.read/fs.write，应改用 fs.readFileSync/fs.writeFileSync' },
    { id: 'TIMEOUT_RISK', level: 'warn', pattern: /while\s*\(\s*true\s*\)|for\s*\(\s*;;\s*\)/g, msg: '死循环风险：JS 沙箱默认 timeout 10s' },
  ],
  py: [
    { id: 'FORBIDDEN_SUBPROCESS', level: 'error', pattern: /\b(subprocess|os\.system|os\.popen|pty)\b/g, msg: '沙箱无 shell/子进程能力，此调用会失败' },
    { id: 'FORBIDDEN_NET', level: 'error', pattern: /\bimport\s+socket\b|\bsocket\.\s*/g, msg: '沙箱网络受限，应使用 pyfetch/requests(如可用)' },
    { id: 'FORBIDDEN_CTYPES', level: 'error', pattern: /\bctypes\b/g, msg: '沙箱禁用原生代码互操作' },
    { id: 'DANGEROUS_EVAL', level: 'error', pattern: /\beval\s*\(|\bexec\s*\(/g, msg: 'eval/exec 动态执行被禁用' },
    { id: 'DANGEROUS_IMPORT', level: 'warn', pattern: /__import__\s*\(/g, msg: '动态导入被禁用' },
    { id: 'DANGEROUS_PICKLE', level: 'warn', pattern: /\bpickle\b/g, msg: 'pickle 反序列化有风险，不建议' },
    { id: 'RESTRICTED_PATH', level: 'error', pattern: /['"](?:\/config\/|\/memory\/|\/pipelines\/|\/trash\/)/g, msg: '访问受限目录(沙箱不可见)' },
    { id: 'UPLOADS_WRITE', level: 'warn', pattern: /(?:open|write|unlink|remove|rename)\s*\([^)]*['"]\/uploads\//g, msg: '/uploads 只读，写操作会失败' },
    { id: 'TIMEOUT_RISK', level: 'warn', pattern: /while\s+True\s*:/g, msg: '死循环风险：Pyodide 沙箱默认 timeout 60s' },
  ],
  common: [
    { id: 'RESTRICTED_PATH', level: 'error', pattern: /['"`](\/(?:config|memory|pipelines|trash)\/)/g, msg: '访问受限目录(沙箱不可见)' },
    { id: 'UPLOADS_WRITE', level: 'warn', pattern: /(?:write|open|unlink|rename)\w*\s*\([^)]*['"`]\/uploads\//g, msg: '/uploads 只读，写操作会失败' },
    { id: 'DANGEROUS_EVAL', level: 'error', pattern: /\beval\s*\(|\bexec\s*\(/g, msg: 'eval/exec 动态执行被禁用' },
    { id: 'TIMEOUT_RISK', level: 'warn', pattern: /while\s*\(\s*true\s*\)|while\s+True\s*:|for\s*\(\s*;;\s*\)/g, msg: '死循环风险' },
  ],
};

/* ============ 沙箱全局注入（官方 glue 依赖） ============ */
const SANDBOX = {
  console, WebAssembly, TextEncoder, TextDecoder,
  performance: { now: () => Date.now() },
  self: { location: { href: GLUE_URL } },
  fetch, crypto, setTimeout, clearTimeout, URL, Math, Date, JSON, Promise,
  Uint8Array, Uint16Array, Uint32Array, Int32Array, Float64Array, ArrayBuffer, DataView,
  Error, String, Number, Object, Array, RegExp, Boolean, Symbol, Map, Set, globalThis,
};

async function loadParser() {
  const [glue, wasm] = await Promise.all([
    (await fetch(GLUE_URL)).text(),
    (await fetch(WASM_URL)).arrayBuffer(),
  ]);
  const Module = { wasmBinary: wasm, locateFile: (p) => p, print: () => {}, printErr: () => {} };
  const fn = new Function('Module', ...Object.keys(SANDBOX), glue + '; return TreeSitter;');
  const Parser = fn(Module, ...Object.values(SANDBOX));
  await Parser.init();
  return Parser;
}

function collectIssues(tree) {
  const issues = [];
  (function walk(n, d) {
    if (d > 32) return;
    if (n.isError || n.isMissing) {
      issues.push({
        type: n.isError ? 'ERROR' : 'MISSING',
        row: n.startPosition.row + 1,
        column: n.startPosition.column + 1,
        snippet: n.text.slice(0, 60),
      });
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i), d + 1);
  })(tree.rootNode, 0);
  return issues;
}

/* ============ 主流程（顶层 await） ============ */
// 选最新写入的目标文件（避免 /tmp 残留旧文件干扰）
let target = null, ext = null;
try {
  const names = fs.readdirSync(TMP_DIR).filter(n => n.startsWith(PREFIX));
  if (names.length) {
    const newest = names.map(n => ({ n, m: fs.statSync(TMP_DIR + '/' + n).mtimeMs })).sort((a, b) => b.m - a.m)[0];
    target = TMP_DIR + '/' + newest.n;
    ext = newest.n.slice(PREFIX.length);
  }
} catch (e) { /* 忽略 */ }

if (!target) {
  console.log(JSON.stringify({ tool: 'validate_multi', error: '未找到 /tmp/' + PREFIX + '<ext> 目标文件', verdict: 'FAIL' }, null, 2));
} else if (!LANGS[ext]) {
  console.log(JSON.stringify({ tool: 'validate_multi', target, error: '不支持的语言扩展名: .' + ext + '（支持: ' + Object.keys(LANGS).join('/') + '）', verdict: 'FAIL' }, null, 2));
} else {
  let src;
  try { src = fs.readFileSync(target, 'utf8'); }
  catch (e) {
    console.log(JSON.stringify({ tool: 'validate_multi', target, error: '目标文件不可读: ' + (e.message || e), verdict: 'FAIL' }, null, 2));
  }
  if (src !== undefined) {
    try {
      const Parser = await loadParser();
      const parser = new Parser();
      const lang = await Parser.Language.load(LANGS[ext]);
      parser.setLanguage(lang);
      const tree = parser.parse(src);
      const issues = collectIssues(tree);
      // 静态安全规则
      const rules = SAFETY_RULES[ext] || SAFETY_RULES.common;
      const staticHits = [];
      for (const r of rules) {
        r.pattern.lastIndex = 0;
        let m;
        while ((m = r.pattern.exec(src)) !== null) {
          const line = src.slice(0, m.index).split('\n').length;
          staticHits.push({ rule: r.id, level: r.level, line, msg: r.msg, snippet: src.slice(m.index, m.index + 48).replace(/\n/g, ' ') });
        }
      }
      const syntaxOk = issues.length === 0;
      const first = issues[0];
      const errors = (syntaxOk ? 0 : 1) + staticHits.filter(h => h.level === 'error').length;
      const warnings = staticHits.filter(h => h.level === 'warn').length;
      const verdict = errors > 0 ? 'FAIL' : (warnings > 0 ? 'WARN' : 'PASS');
      const report = {
        tool: 'validate_multi', language: ext, target, engine: 'tree-sitter@0.24.7',
        syntax: syntaxOk ? { ok: true, error: null } : {
          ok: false,
          error: '第' + first.row + '行 第' + first.column + '列 语法错误(' + first.type + ')',
          row: first.row, column: first.column, type: first.type,
        },
        issues, static: staticHits,
        summary: { errors, warnings },
        verdict,
      };
      const json = JSON.stringify(report, null, 2);
      console.log(json);
      try { fs.writeFileSync(RESULT_FILE, json); } catch (e2) { /* 回写失败不致命 */ }
    } catch (e) {
      console.log(JSON.stringify({ tool: 'validate_multi', target, error: '校验器异常: ' + (e && e.message || e), verdict: 'FAIL' }, null, 2));
    }
  }
}
