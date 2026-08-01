/**
 * validate_multi.js — 多语言真解析校验器 v3.2（官方 web-tree-sitter API）
 *
 * 【v3.2 改进（2026-08-02）】
 *  ① 目标选择 fail-fast：沙箱 stat 无时间字段(v3.1 因此静默选错) → 多候选一律列候选 FAIL；
 *     支持 /tmp/.validate_target.flag 文件显式指定目标（沙箱无 env，用文件传参）
 *  ② errors 计数修正：按去嵌套后实际语法错误节点数统计（v3.1 把 N 个错误合并为 1）
 *  ③ collectIssues 取最深错误叶子：ERROR 父节点含子错误时跳过父（修复 tsx/cpp/cs/rb 上抛 1:1）
 *  ④ 静态规则注释/字符串感知：扫描前剥离注释与字符串（等长空白替换，保行列号）→ 消除误报
 *  ⑤ Python 缩进兜底：PY_INDENT 启发式（冒号块后缩进未增加 → warn），补 tree-sitter 宽容放行的漏
 *  ⑥ wasm/glue 本地缓存：/sandbox/_ts_cache/ 优先读，miss 则 fetch 并落盘 → 离线可用 + 提速
 *
 * 【能力】14 种主流语言语法真解析（tree-sitter AST）: js/ts/tsx/py/java/go/c/cpp/csharp/rust/ruby/php/json/bash
 * 【原理】加载官方 web-tree-sitter@0.24.7 glue（自带 WASI imports/PIC 初始化/回调注册），
 *        用官方 Parser/Language API 解析，错误节点(isError/isMissing)遍历定位行列。
 * 【调用协议】
 *   ① filesystem create /tmp/_validate_target.<ext>   ← 待校验源码(扩展名决定语言)
 *      (可选: filesystem create /tmp/.validate_target.flag 内容为目标文件名 → 显式指定，跳过自动选择)
 *   ② code_runner path="/downloads/validate_multi.js" timeout=60000
 *   ③ 解析 stdout JSON
 * 【输出】{tool,version,language,target,engine,meta,syntax{ok,error,row,column},issues[],static[],summary,verdict}
 *   verdict: errors>0→FAIL | warnings>0→WARN | PASS
 */
'use strict';
const fs = require('fs');

/* ============ 配置 ============ */
const GLUE_URL = 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.24.7/tree-sitter.js';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.24.7/tree-sitter.wasm';
const TMP_DIR = '/tmp';
const RESULT_FILE = '/sandbox/_validate_multi_result.json';
const CACHE_DIR = '/sandbox/_ts_cache';
const PREFIX = '_validate_target.';
const VERSION = '3.2';
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

/* ============ 缓存加载（⑥：离线可用） ============ */
function ensureCacheDir() { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* 只读则忽略 */ } }
async function loadWithCache(url, name, isBinary) {
  const file = CACHE_DIR + '/' + name;
  let fromCache = false;
  try {
    if (fs.existsSync(file)) {
      const buf = fs.readFileSync(file);
      fromCache = true;
      return { data: isBinary ? new Uint8Array(buf) : buf.toString('utf8'), fromCache };
    }
  } catch (e) { /* 缓存损坏则回退 fetch */ }
  const res = await fetch(url);
  const data = isBinary ? new Uint8Array(await res.arrayBuffer()) : await res.text();
  try { ensureCacheDir(); fs.writeFileSync(file, data); } catch (e) { /* 落盘失败不致命 */ }
  return { data, fromCache };
}

async function loadParser() {
  ensureCacheDir();
  const [glue, wasm] = await Promise.all([
    loadWithCache(GLUE_URL, 'tree-sitter.js', false),
    loadWithCache(WASM_URL, 'tree-sitter.wasm', true),
  ]);
  const Module = { wasmBinary: wasm.data, locateFile: (p) => p, print: () => {}, printErr: () => {} };
  const fn = new Function('Module', ...Object.keys(SANDBOX), glue.data + '; return TreeSitter;');
  const Parser = fn(Module, ...Object.values(SANDBOX));
  await Parser.init();
  return { Parser, wasmCached: wasm.fromCache };
}

/* ============ 注释/字符串剥离（④：静态扫描前置，等长空白保行列号） ============ */
function stripCommentsAndStrings(src, ext) {
  const out = src.split('');
  const n = out.length;
  const isPy = ext === 'py', isSh = ext === 'sh', isJs = ext === 'js' || ext === 'ts' || ext === 'tsx';
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < n) {
    const c = out[i], c1 = out[i + 1];
    // 行注释: // 或 #(py/sh)
    if ((c === '/' && c1 === '/') || (c === '#' && (isPy || isSh))) {
      let j = i; while (j < n && out[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    // 块注释: /* */ 或 <!-- -->
    if (c === '/' && c1 === '*') {
      let j = src.indexOf('*/', i + 2); if (j < 0) j = n; else j += 2;
      blank(i, j); i = j; continue;
    }
    if (c === '<' && out[i + 1] === '!' && out[i + 2] === '-' && out[i + 3] === '-') {
      let j = src.indexOf('-->', i + 4); if (j < 0) j = n; else j += 3;
      blank(i, j); i = j; continue;
    }
    // 字符串: ' " `(js) 与 py 三引号
    if (c === '"' || c === "'" || (c === '`' && isJs)) {
      if (isPy && (src.slice(i, i + 3) === '"""' || src.slice(i, i + 3) === "'''")) {
        const q = src.slice(i, i + 3);
        let j = src.indexOf(q, i + 3); if (j < 0) j = n; else j += 3;
        blank(i, j); i = j; continue;
      }
      let j = i + 1, esc = false;
      while (j < n) {
        const ch = out[j];
        if (esc) { esc = false; j++; continue; }
        if (ch === '\\') { esc = true; j++; continue; }
        if (ch === c) break;
        j++;
      }
      blank(i, Math.min(j + 1, n)); i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

/* ============ Python 缩进启发式（⑤：tree-sitter 宽容放行时的补漏） ============ */
function pyIndentIssues(src) {
  const issues = [];
  const lines = src.split('\n');
  let blockIndent = null, pending = false;
  const isBlockKw = (t) => /^(else|elif|except|finally)\b/.test(t);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (pending && !isBlockKw(trimmed)) {
      if (indent <= blockIndent) {
        issues.push({ rule: 'PY_INDENT', level: 'warn', line: i + 1, msg: '疑似缩进错误(冒号块后缩进未增加)，tree-sitter 宽容放行，建议真实解释器试跑', snippet: trimmed.slice(0, 48) });
      }
      pending = false;
    }
    const colonIdx = trimmed.lastIndexOf(':');
    if (colonIdx >= 0 && trimmed.slice(colonIdx + 1).trim() === '' && /^(if|elif|else|while|for|def|class|try|except|finally|with|async)\b/.test(trimmed)) {
      blockIndent = indent; pending = true;
    }
  }
  return issues;
}

/* ============ 错误节点收集（③：取最深叶子，修复 tsx/cpp/cs/rb 上抛 1:1） ============ */
function collectIssues(tree) {
  const issues = [];
  (function walk(n, d) {
    if (d > 32) return;
    if (n.isError || n.isMissing) {
      let hasChildErr = false;
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (c.isError || c.isMissing) { hasChildErr = true; break; }
      }
      if (!hasChildErr) {
        issues.push({
          type: n.isError ? 'ERROR' : 'MISSING',
          row: n.startPosition.row + 1,
          column: n.startPosition.column + 1,
          snippet: n.text.slice(0, 60),
        });
      }
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i), d + 1);
  })(tree.rootNode, 0);
  return issues;
}

/* ============ 主流程 ============ */
await (async () => {
  let target = null, ext = null;
  // 显式指定通道：/tmp/.validate_target.flag 内容为目标文件名（沙箱无 env，用文件传参）
  let explicit = '';
  try {
    const flag = fs.readFileSync(TMP_DIR + '/.validate_target.flag', 'utf8').trim();
    if (flag) explicit = flag.startsWith('/') ? flag : TMP_DIR + '/' + flag;
  } catch (e) { /* 无 flag 则走自动选择 */ }
  let names = [];
  try { names = fs.readdirSync(TMP_DIR).filter(n => n.startsWith(PREFIX) && n.length > PREFIX.length); } catch (e) { /* 目录不可读 */ }

  if (explicit) {
    // ①显式指定优先，完全跳过猜测
    if (fs.existsSync(explicit)) { target = explicit; ext = explicit.slice(explicit.lastIndexOf('.') + 1); }
    else { console.log(JSON.stringify({ tool: 'validate_multi', version: VERSION, error: '显式目标不存在: ' + explicit + '（flag: /tmp/.validate_target.flag）', verdict: 'FAIL' }, null, 2)); return; }
  } else if (names.length) {
    if (names.length > 1) {
      // ①沙箱 stat 无时间字段，无法区分新旧 → fail-fast 列出候选，要求清理或用 flag 显式指定
      console.log(JSON.stringify({
        tool: 'validate_multi', version: VERSION,
        error: '检测到多个候选目标文件，沙箱无法按时间区分新旧。候选: ' + names.join(', ') + '。请清理旧文件后重跑，或写 /tmp/.validate_target.flag 内容为目标文件名显式指定。',
        candidates: names, verdict: 'FAIL',
      }, null, 2));
      return;
    }
    target = TMP_DIR + '/' + names[0];
    ext = names[0].slice(PREFIX.length);
  }

  if (!target) {
    console.log(JSON.stringify({ tool: 'validate_multi', version: VERSION, error: '未找到 /tmp/' + PREFIX + '<ext> 目标文件', verdict: 'FAIL' }, null, 2));
    return;
  }
  if (!LANGS[ext]) {
    console.log(JSON.stringify({ tool: 'validate_multi', version: VERSION, target, error: '不支持的语言扩展名: .' + ext + '（支持: ' + Object.keys(LANGS).join('/') + '）', verdict: 'FAIL' }, null, 2));
    return;
  }

  let src;
  try { src = fs.readFileSync(target, 'utf8'); }
  catch (e) {
    console.log(JSON.stringify({ tool: 'validate_multi', version: VERSION, target, error: '目标文件不可读: ' + (e.message || e), verdict: 'FAIL' }, null, 2));
    return;
  }

  try {
    const { Parser, wasmCached } = await loadParser();
    const parser = new Parser();
    const langWasm = await loadWithCache(LANGS[ext], 'lang-' + ext + '.wasm', true);
    const lang = await Parser.Language.load(langWasm.data);
    parser.setLanguage(lang);
    const tree = parser.parse(src);

    // 语法问题：去嵌套后的 ERROR/MISSING 叶子节点（②：按节点数计数，不再合并为 1）
    const issues = collectIssues(tree);

    // 静态安全规则：先剥离注释/字符串再匹配（④：消除误报）
    const rules = SAFETY_RULES[ext] || SAFETY_RULES.common;
    const stripped = stripCommentsAndStrings(src, ext);
    const staticHits = [];
    for (const r of rules) {
      r.pattern.lastIndex = 0;
      let m;
      while ((m = r.pattern.exec(stripped)) !== null) {
        const line = src.slice(0, m.index).split('\n').length;
        staticHits.push({ rule: r.id, level: r.level, line, msg: r.msg, snippet: src.slice(m.index, m.index + 48).replace(/\n/g, ' ') });
      }
    }
    if (ext === 'py') staticHits.push(...pyIndentIssues(src));

    const syntaxOk = issues.length === 0;
    const first = issues[0];
    const errors = issues.length + staticHits.filter(h => h.level === 'error').length;
    const warnings = staticHits.filter(h => h.level === 'warn').length;
    const verdict = errors > 0 ? 'FAIL' : (warnings > 0 ? 'WARN' : 'PASS');

    const report = {
      tool: 'validate_multi', version: VERSION, language: ext, target, engine: 'tree-sitter@0.24.7',
      meta: { wasmCached },
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
    console.log(JSON.stringify({ tool: 'validate_multi', version: VERSION, target, error: '校验器异常: ' + (e && e.message || e), verdict: 'FAIL' }, null, 2));
  }
})();
