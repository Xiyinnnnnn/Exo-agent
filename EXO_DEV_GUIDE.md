# Exo Agent 操作手册 v3（自包含版）

> **用途**：仅凭本文档 + `index.html` 源码，下一个 agent 即可独立完成任何修改、调试与验证。**本手册自包含，不依赖任何附加文档**。
> **源码版本**：`index.html` 24876 行（FIX-2026-08-04-h 后）。**行号随版本漂移，所有定位以 grep 函数名为准，行号仅参考**。
> **历史**：旧版教程归档于 `EXO_DEV_GUIDE.legacy.md`（非必需，仅考古用）；各轮 REVIEW 报告仅留第 6 章索引，不须另行阅读。

---

## 0. 操作协议（每次任务必须执行）

### 0.1 任务前

1. 读本章（协议）+ 第 5 章（架构约束）+ 第 6 章（历史索引）——避免重蹈历史覆辙。
2. **grep 定位**目标函数（`fuzzy_search mode=content`，限定 `/uploads/index.html`），读源码确认调用方与被调方。
3. 判断任务级别：L1 单点 / L2 多点多函数 / L3 跨子系统 → **L3+ 先建 todo 清单**，逐条 start→done（done 必附 evidence）。
4. 查询记忆/知识库是否有历史结论（`longterm_memory query` / `knowledge_base query`）。

### 0.2 修改协议（8 步）

| 步 | 动作 | 强制 |
|---|---|---|
| 1 | 备份：`filesystem copy index.html → index.html.bak.vN`（N 递增） | 是 |
| 2 | grep 定位所有目标，**禁止依赖记忆行号** | 是 |
| 3 | **从下到上**修改（先大行号，防小行号改动导致大行号错位） | 是 |
| 4 | 每 3 处改动跑一次语法验证（脚本 S1） | 是 |
| 5 | 全量语法验证 + 语义单测（脚本 S1+S2） | 是 |
| 6 | diff 与备份逐块核对（脚本 S3）：删除行全部可追溯 | 是 |
| 7 | 修复注释 `// ★ [FIX-YYYY-MM-DD-x] 病因：… 修复：…`（严谨术语，无过程叙述） | 是 |
| 8 | 更新本文档第 6/7 章 + 记忆沉淀（longterm_memory + knowledge_base） | 是 |

### 0.3 验证协议（三层）

1. **语法层**：主文件 `new Function` 全量 0 错误（S1）；worker 拼接片段还原后语法 0 错误（S4）。
2. **语义层**：eval 提取目标函数 + mock 依赖跑单测（S2），覆盖新增分支与回归路径。
3. **隔离层**：铁律点频率比对（S5）——只动渲染/工具路径时铁律点必须与备份全等。

### 0.4 交付协议

- 产出物写文件（报告/文档），不口头交付；简单问答可直接回复。
- 修复注释与报告均用严谨术语，无"心路历程"式叙述。

---

## 1. Agent 工作环境（哪里能用，哪里要注意）

### 1.1 本 Agent 可用的工具环境

| 工具 | 用途 | 注意 |
|---|---|---|
| `filesystem` | 读写源码/文档/脚本 | `/uploads/` **只读**（源码+备份）；`/sandbox/` 可写（检测脚本）；行操作**从下到上**；改完复读确认 |
| `code_runner` | 执行检测脚本 | **主模式**：先 `filesystem create` 脚本到 `/sandbox/`，再 `path` 运行（比 code 直传更稳、可复跑）；JS 默认超时 30s，Python 120s |
| `fuzzy_search` | grep 定位（content 模式） | 限定 `file: index.html` 防误命中 bak 系列；定位函数一律用它，**不用记忆行号** |
| `todo` | L3+ 任务拆解 | 先 create 清单，逐条 start→done，done 附 evidence；每会话仅一个活跃清单 |
| `longterm_memory` / `knowledge_base` | 记忆沉淀/复用 | 任务前 query 查历史结论；任务后 store 沉淀 |
| `calculator` | 精确计算 | 不目测不心算 |

### 1.2 文件系统权限

| 分区 | 权限 | 说明 |
|---|---|---|
| `/uploads/` | 只读 | 源码 `index.html`、本文档、备份 `index.html.bak.vN`（N 递增到 v9+） |
| `/sandbox/`、`/downloads/`、`/tmp/` | 读写 | 检测脚本与临时文件，**用完删除**（移入 /trash/） |
| `/config/`、`/memory/`、`/pipelines/`、`/trash/` | 不可见/只读 | 不涉及 |

### 1.3 code_runner 沙箱（关键差异，踩过坑）

- **JS 沙箱（非 Node）**：注入 `require/console/fetch/fs/process/Buffer/global(=api)/window(=api)`；**无默认 globalThis**；支持**顶层 await**（module 模式）。
- 读源码：`require('fs').readFileSync('/uploads/index.html','utf8')` 返回字符串（1.3MB 完整可载）。
- **Python 沙箱**（Pyodide）：`compile()` 编译的是 **Python**——验证 JS 语法必须用 JS 的 `new Function`，勿混用。
- 诊断手法：脚本报错时**逐段打印打点**（D1/D2/...）定位；报"编译期"错先检查 eval 提取的代码是否丢了 `async`（见 S2 纪律 1）。
- 沙箱内 mock DOM：无 jsdom，需手写最小 mock（见 S2 纪律 3）。

### 1.4 检测脚本库（完整可复用，直接存 `/sandbox/` 运行）

#### S1 语法验证（每次改完必跑）

```js
// 保存为 /sandbox/s1_syntax.js → code_runner path=/sandbox/s1_syntax.js
var fs2=require('fs');
var src=fs2.readFileSync('/uploads/index.html','utf8');
var blocks=[],re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g,m;
while((m=re.exec(src)))blocks.push(m[1]);
var err=0;
blocks.forEach(function(b,i){
  try{new Function(b);}catch(e){err++;console.log('[语法错误 '+i+']',e.message);}
});
console.log('内联script块:',blocks.length,'| 语法错误:',err);
```

#### S2 语义单测模板（eval 提取函数，三纪律）

```js
// 保存为 /sandbox/s2_unittest.js → 修改"目标函数"与断言后运行
var fs2=require('fs');
var src=fs2.readFileSync('/uploads/index.html','utf8');
var pass=0,fail=0;
function assert(name,cond){if(cond){pass++;console.log('PASS',name);}else{fail++;console.log('FAIL',name);}}
function extractFunc(src,name){
  var re=new RegExp('(?:async\\s+)?function\\s+'+name+'\\s*\\([^)]*\\)\\s*\\{'); // 纪律1：必须支持 async 前缀
  var m=re.exec(src);if(!m)throw new Error('not found '+name);
  var d=0,j=m.index+m[0].length-1;
  for(;j<src.length;j++){if(src[j]==='{')d++;else if(src[j]==='}'){d--;if(d===0)break;}}
  return src.slice(m.index,j+1);
}
// 纪律2：函数内裸标识符依赖必须脚本顶层 var 绑定（global.x= 不建立全局环境绑定）
var taskWorker={postMessage:function(x){}};   // 例：mock 依赖
var _thPending=null,_thRAF=0;                 // 例：被测函数的外部状态
eval(extractFunc(src,'目标函数'));            // 改这里
// 纪律3：DOM mock 的 querySelector 匹配须与真实选择器一致（'[id="x"]' 的 indexOf 不为 0，用 >0）
assert('示例断言', true);
console.log('--- PASS='+pass+' FAIL='+fail);
```

#### S3 diff 核对（与备份逐块核对）

```python
# 保存为 /sandbox/s3_diff.py → code_runner path=/sandbox/s3_diff.py
import difflib
cur=open('/uploads/index.html',encoding='utf-8').read()
bak=open('/uploads/index.html.bak.v9',encoding='utf-8').read()  # 改成最新备份号
cl,bl=cur.split('\n'),bak.split('\n')
n=0
for tag,i1,i2,j1,j2 in difflib.SequenceMatcher(None,bl,cl).get_opcodes():
    if tag!='equal':
        n+=1
        print(f'{tag}: bak L{i1+1}-{i2}(删{i2-i1}) → cur L{j1+1}-{j2}(增{j2-j1})')
print(f'差异块: {n} | 每块须能对应一处有意修改')
```

#### S4 worker 拼接片段还原验证（worker 源码是字符串拼接，无法直接执行）

```js
// 保存为 /sandbox/s4_worker_verify.js → 运行；目标段起止按需调整
var fs2=require('fs');
var src=fs2.readFileSync('/uploads/index.html','utf8');
function extractFunc(src,name){
  var re=new RegExp('(?:async\\s+)?function\\s+'+name+'\\s*\\([^)]*\\)\\s*\\{');
  var m=re.exec(src);if(!m)throw new Error('not found '+name);
  var d=0,j=m.index+m[0].length-1;
  for(;j<src.length;j++){if(src[j]==='{')d++;else if(src[j]==='}'){d--;if(d===0)break;}}
  return src.slice(m.index,j+1);
}
var bts=extractFunc(src,'buildTaskWorkerSource');
var seg=bts.slice(bts.indexOf("src+='var _abortedTasks"),bts.indexOf("src+='};\n';")+12); // 起止锚点
var ws='',re2=/src\+='((?:\\.|[^'\\])*)'/g,mm;
while((mm=re2.exec(seg))){ ws+=eval("'"+mm[1]+"'"); }  // 逐行还原转义
try{ new Function(ws); console.log('worker 片段语法 0 错误, 长度',ws.length); }
catch(e){ console.log('worker 片段语法错误:',e.message); }
```

#### S5 铁律点频率比对（隔离回归）

```js
// 保存为 /sandbox/s5_isolation.js → 运行；只动渲染/工具路径时铁律点必须与备份全等
var fs2=require('fs');
var cur=fs2.readFileSync('/uploads/index.html','utf8');
var bak=fs2.readFileSync('/uploads/index.html.bak.v9','utf8');  // 改成最新备份号
var keys=['_streamTargetConvId','cs._origConvId','_stConvId','_withFileLock','_dirtyMsgIds','saveCurrentMessages'];
keys.forEach(function(k){
  var a=(cur.match(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length;
  var b=(bak.match(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length;
  console.log((a===b?'OK  ':'DIFF')+' '+k+': cur='+a+' bak='+b);
});
```

---

## 2. 源码地图（grep 优先）

### 2.1 分区布局

```
L635-1152     HTML+CSS（UI：toolbar/sidebar/chat/settingsDrawer/editModal/debugPanel）
L1152-24876   单块 JS（ES5 风格：var+function；含分区注释 ===== 第 N 部分 =====）
L8162/8756    buildEvoWorkerSource / buildTaskWorkerSource（Worker 源码字符串拼接）
L9868         WorkerManager（Base64/Blob 创建 + 崩溃重启）
L10585        sendToTaskWorker（请求-响应 + 超时 + abort_task 取消协议）
L13159        _withTimeout（工具超时 + onTimeout 取消钩子）
L13129        executeTool（工具执行中枢）
L18045        processUserMessage（消息处理总管线）
L24483        renderConversationList（会话列表）
```

### 2.2 核心函数索引（按子系统，grep 定位）

| 子系统 | 函数 | 职责 |
|---|---|---|
| 管线 | `processUserMessage` / `streamChatCompletion` / `_buildLLMRequest` | 总管线 / 流式 LLM / 请求组装 |
| 管线 | `_validateMessageSequence` / `_compressOldMessages` | 消息序列校验 / 上下文压缩 |
| 工具 | `executeTool` / `executeMainThreadTool` / `executeTaskWorkerTool` | 执行中枢 / 主线程分发 / Worker 分发 |
| 工具 | `_withTimeout` / `sendToTaskWorker` / `TOOL_REGISTRY` | 超时+取消 / worker 请求 / 42 工具注册表 |
| 工具 | `resolveToolName` / `normalizeToolInvocation` / `validateToolParams` | 别名兜底 / 三级归一化 / schema 校验 |
| 渲染 | `renderMarkdown` / `sanitizeArtifactHTML` / `_renderStreamContent` | markdown+KaTeX+净化 / 产物净化 / 流式降级 |
| 渲染 | `updateThinkingBlock` / `_flushThinkingBlock` | thinking 节流（RAF 合并）/ 冲刷 |
| 会话 | `switchConversation` / `saveCurrentMessages` / `_saveBranchMessages` | 切换 / 落库（带守卫）/ 分支持久化 |
| 会话 | `newConversation` / `deleteConversation` / `_getBranchData` | 新建 / 删除 / 分支数据 |
| 心流 | `toolFlowMode` / `processFlowTurn` / `flowExecuteLoop` / `flowDeliver` | 入口（阻塞）/ 回合 / 监工循环 / 交付 |
| 存储 | `getDB` / `idbTransaction` / `_withFileLock` | 连接 / 事务封装 / per-path 写锁 |
| 存储 | `createFile` / `readFile` / `updateFile` / `deleteFile` | 虚拟文件系统 |
| Worker | `buildTaskWorkerSource` / `buildEvoWorkerSource` / `handleTaskWorkerMessage` | worker 源码 / 消息处理 |
| 状态 | `_ensureConvState` / `_getTodos` / `_setFlowSession` | 对话状态 / todo / flow 会话（均键控 convId） |

### 2.3 数据存储

| 位置 | 内容 |
|---|---|
| IndexedDB `ExoDB` v2 | `files`(虚拟文件系统,key=path) / `model_cache`(嵌入模型+IDF) / `conversations`(会话元数据) / `messages`(分支消息 branches) |
| localStorage | `exo_last_conv` / `exo_token_counts` / `exo_fullmsg_snap_<convId>`(崩溃快照) / `exo_scroll_<convId>` |

### 2.4 双 Worker 与消息协议

| | evoWorker | taskWorker |
|---|---|---|
| 职责 | 反思/技能补丁/文件锁/代理LLM | 本地嵌入/搜索/执行 |
| 消息 | 事件模式（无 id）+ 请求-响应 | 请求-响应（带 id，`pendingWorkerRequests` 关联） |

- 新增 worker 消息三步：主线程 `handleXxxWorkerMessage` 加 case → worker 源码 `src+='...'` 加 case → `replyTo` 关联回复。
- **Worker 源码是字符串拼接：禁止模板字符串（`${}` 被主线程抢先解析）；无 DOM/localStorage；worker 无网络，LLM 调用走 `handleProxyLLMCall` 主线程代发**。
- 取消协议：主线程 abort → `postMessage({type:'abort_task',id})` → worker 标记 `_abortedTasks[id]` → 结果不回传（串行模型下不中断执行中任务）。

---

## 3. 修改指南（怎么做）

### 3.1 新增工具（五步）

1. 写执行函数 `async function toolXxx(args, extSignal)`——放 `executeMainThreadTool` 附近工具区；返回规范见 3.1.1。
2. `TOOL_REGISTRY` 登记：`{name, description, executor:'main'|'task_worker', flow_role:'root'|'supervisor', disabled}`。
3. `executeMainThreadTool` 加 `case 'xxx': return await toolXxx(args);`（或 `executeTaskWorkerTool` 加 case）。
4. 可选：`validateToolParams` 区域加参数 schema（LLM 传错参数本地拦截）；`_toolType` 加结果类型提示。
5. 安全红线：沙箱路径按对话隔离（`/sandbox/<convId>/`）；HTML 产物必须过 `sanitizeArtifactHTML`；路径走 `normalizePath`；写共享文件必须 `_withFileLock`。

#### 3.1.1 返回值规范

| 形态 | 触发条件 | 结果 |
|---|---|---|
| `{html:'...'}` | 图表/可视化产物 | 进 artifacts 注册表 → 渲染气泡 |
| 字符串 | 常规 | header + 内容（空串→`empty`） |
| 对象 | 结构化 | `JSON.stringify(,null,2)` 美化 |
| 抛异常 | 失败 | `---tool:xxx err ms ch tool_error---` + 失败注入 |

统一 header：`---tool:name status ms ch type---`（LLM 依赖它判断状态）。

### 3.2 新增 worker 消息（三步）

1. 主线程 `handleEvoWorkerMessage`/`handleTaskWorkerMessage` 加 case，处理并 `postMessage({replyTo:msg.id,...})`。
2. worker 源码（`buildXxxWorkerSource` 的 `src+='...'` 字符串）加对应 case。
3. 需要回复用 `replyTo` 关联；纯通知用事件模式。**禁止模板字符串拼接 worker 源码（`${}` 冲突）；worker 无网络，LLM 调用走 `handleProxyLLMCall` 主线程代发**。

### 3.3 新增按对话隔离状态（五步）

1. 建 Map：`var _convXxx = {};`（`_conv` 前缀约定）。
2. 读写辅助：`function _getXxx(convId){return _convXxx[convId||currentConversationId]||null;}`。
3. 处理路径显式传发起对话（`cs._origConvId || currentConversationId`，铁律 1）。
4. 切换保存/恢复：`switchConversation` 加快照逻辑（参考 `_stmEntries` 模式）。
5. 删除清理：`deleteConversation` 里 `delete _convXxx[convId]`。

### 3.4 新增设置项

HTML（settingsDrawer）→ `loadSettings`/`saveSettings` 字段读写 → `applySettingsToUI` 回填 → 使用处 `settings.xxx`。**settings 是全局单值，不得存放对话级数据**。

### 3.5 修改渲染路径（三路径原则）

| 路径 | 适用 | 实现 | 约束 |
|---|---|---|---|
| 降级 | 流式中间态高频全量渲染 | `_renderStreamContent`：`_looksLikeMarkdown` 宽松检测 → 纯文本走 `textContent`（O(1)），有语法才全量 | 宽松匹配宁全量勿漏；流结束最终渲染必须全量（质量优先） |
| 缓存 | 稳定态同一内容重复渲染 | `renderMarkdown` 的 `_mdHtmlCache`（key=**katex状态前缀+原文**）/ `sanitizeArtifactHTML` 的 `_artSanCache`（key=原文） | DOMPurify 输出**原样缓存**（减计算不减防护）；超限 `clear()` |
| 节流 | 高频小更新 | `updateThinkingBlock` RAF 单槽位合并 + 完成处 `_flushThinkingBlock()` 显式冲刷 | 冲刷必须在流式完成处调用（页面隐藏时 RAF 暂停会丢末帧） |

### 3.6 修改工具超时/取消（链路）

```
_withTimeout(promise,ms,label,onTimeout)  超时触发 onTimeout（协作式取消钩子）
  └─ executeTool：new AbortController() → 传给 execute* 函数 → onTimeout=abort()
       ├─ task_worker 工具：signal → sendToTaskWorker(type,params,timeout,signal)
       │    ├─ signal.aborted 检查必须置于 postMessage 之前（否则发无效任务消息）
       │    └─ abort 事件 → postMessage({type:'abort_task',id}) + reject + 清理 pendingWorkerRequests
       └─ 主线程 fetch 类工具：AbortSignal.any([内部timeout, 外部signal]) 合并
```

- `Promise.race` 只放弃等待不取消底层——取消必须协作式（AbortSignal/消息协议）。
- worker 串行 await 模型：abort_task 消息排队于当前任务之后，不中断执行中任务（fetch 类已有内部超时兜底）；协议价值=结果丢弃完备 + 为并行化铺路。

---

## 4. 调试指南（如何调试）

### 4.1 症状 → 病因速查表

| 症状 | 病因 | 排查入口 |
|---|---|---|
| 回复内容串了别的对话 | 历史读取用了 currentConversationId（铁律10） | processUserMessage |
| 点停止没反应/停错对话 | stopRequested/controller 写错对话（铁律5/6） | streamChatCompletion |
| 心流点了没反应 | flowSession() 读错对话（铁律8） | processFlowTurn |
| 反思太频繁/不反思 | task 通知重复/丢失（铁律7） | processUserMessage finally/catch |
| token 计数跳变 | 累计器写错对话 | `_convTokenAccumulator` |
| 刷新后消息丢失 | 崩溃快照/落库竞态 | `exo_fullmsg_snap_*` |
| 双对话并行写同一文件丢数据 | 没走 `_withFileLock` | updateFile |
| API 400 tool 消息孤立 | 删了 assistant 没删 tool | `_validateMessageSequence` |
| 超时后工具仍执行/重试并发 | 无取消链路 | `_withTimeout`/`sendToTaskWorker` |
| 渲染卡顿（长回复流式） | 每帧全量 markdown | `_renderStreamContent` 降级路径 |
| thinking 文本抖动 | chunk 密集全量替换 | `updateThinkingBlock` RAF 路径 |
| 脚本报"编译期"语法错 | eval 提取丢了 `async`（S2 纪律1） | 检查 extractFunc 正则 |

### 4.2 并发 bug 定位流程

1. 复现：两个对话并行，处理 A 时切到 B，观察 B 的 DOM/数据是否出现 A 内容。
2. 全量 grep `currentConversationId`，逐项判定：是否可能被异步调用 / 是否在 await 之后 / 是否写共享状态。
3. 打点对比：`debugLogger.info('ctx='+currentConversationId+' 期望='+xxx)`。
4. 按铁律改（第 5 章）→ S1 语法验证 → 双对话复测。

### 4.3 沙箱单测三纪律（违反必翻车）

1. **extractFunc 正则必须支持 `async` 前缀**——否则 async 函数被提取为普通函数，体内 `await` 直接 SyntaxError（表现为"编译期"报错，误导定位）。
2. **eval 函数内裸标识符依赖必须脚本顶层 `var` 绑定**——`global.x=` 只挂属性不建全局环境绑定，函数内解析不到（报 `xxx is not defined`）。
3. **DOM mock 匹配条件与真实选择器一致**——`querySelector('[id="x"]')` 传入 `'[id="x"]'` 字符串，`indexOf('x')` 不为 0，用 `>0` 或精确解析。

### 4.4 worker 片段还原验证

worker 源码是 `src+='...'` 字符串拼接，无法直接执行；用脚本 **S4** 提取 `buildTaskWorkerSource` 内目标段 → 逐行还原转义 → `new Function` 语法验证。

### 4.5 隔离回归检查点（铁律点频率比对）

改完用脚本 **S5** 对比以下标识符出现次数，**只动渲染/工具路径时必须全等**：`_streamTargetConvId` / `cs._origConvId` / `_stConvId` / `_withFileLock` / `_dirtyMsgIds` / `saveCurrentMessages` 目标守卫 / `switchConversation` 双重守卫。

### 4.6 行号纪律

- 插入/删除后后续行号整体偏移，**每次定位重新 grep**，禁止依赖记忆行号（历史上多次因此误插）。
- 多行修改一律**从下到上**（先大行号后小行号）。
- 连续改 3 处以上即重跑语法验证（单文件 1.2MB，语法错误导致整块脚本失效）。

---

## 5. 架构约束（修改前必读）

### 5.1 十条隔离铁律（违反即"处理A时切到B，A数据写进B"）

| # | 铁律 | 正确写法 |
|---|---|---|
| 1 | 异步收尾用发起对话 | 函数开头 `var _finConvId = cs._origConvId \|\| currentConversationId`，收尾全用它 |
| 2 | 流式写目标锁定 | processUserMessage 开头 `_streamTargetConvId=currentConversationId`，finally 恢复/清空 |
| 3 | 共享缓存 key 含 convId | `_cacheKey = convId + '\|' + toolNames.join(',')` |
| 4 | 工具执行路径用发起对话 | `var convId = _streamTargetConvId\|\|currentConversationId` |
| 5 | window 代理值条件同步 | `if(currentConversationId===_stConvId)activeLLMController=controller;` + `cs.llmController=controller` |
| 6 | stopRequested 用发起对话 | `var cs=_ensureConvState(_stConvId)`（流式函数开头捕获） |
| 7 | worker 通知只在收尾发一次 | processUserMessage finally 发 task_success / catch 发 task_failure（流式层禁止） |
| 8 | flow 状态显式传 convId | `_flowSessions[cs._origConvId\|\|currentConversationId]`，不用 `flowSession()` 裸读 |
| 9 | DOM 永远属于当前显示对话 | `saveCurrentMessages` 守卫：`_targetConvId!==currentConversationId → return` |
| 10 | await 边界后重新确认身份 | await 后读历史/快照用捕获的发起对话 ID；switchConversation await 后双重守卫 |

**有意豁免**（保留 currentConversationId）：`_calendarWakeCheck`（唤醒=当前可见对话）、`handleProxyLLMCall`（全局空闲语义）、beforeunload（同步无竞态）、`_stopGeneration`（停止按钮=当前对话）。

### 5.2 安全机制（5 类，性能优化不得放宽）

1. 拦截门（`honesty_intensity>=2` 才启用）：中危参数检查（零 API）→ 高危 LLM 审查（`_preExecutionCritique`）→ 通过才执行。
2. DOMPurify 净化：renderMarkdown / sanitizeArtifactHTML（白名单 ADD_TAGS/ADD_ATTR）——**可缓存净化结果，不可跳过净化**。
3. 审查门：自评估强度 1/3 时的审查官+修正师循环。
4. 路径防护：`normalizePath` 防穿越；沙箱按对话隔离。
5. 文件锁：`_withFileLock` per-path 串行写。

### 5.3 红线（禁止修改）

1. 不要删 window 代理（200+ 处旧代码兼容层）。
2. 不要在 streamChatCompletion 加 task_success/failure 通知（铁律 7 重复计数）。
3. 不要移除 saveCurrentMessages 目标守卫 / switchConversation await 后守卫。
4. 不要动 `_withFileLock` 包锁点（并发写丢数据最隐蔽）。
5. 不要用模板字符串拼 worker 源码（`${}` 冲突）。
6. 不要改 DB_VERSION 结构不兼容（升级路径只有 onupgradeneeded）。
7. 不要放宽净化强度做性能优化（先查重复计算，再查计算本身）。

### 5.4 反模式

1. "直接用 currentConversationId 应该没问题"——历史 69+ 处修复均源于此。
2. "加个全局变量方便"——共享状态默认按对话隔离，除非明确全局语义。
3. "先写完再统一测试"——单文件必须小步验证。
4. "压缩上下文顺便改骨架逻辑"——骨架/items 双轨牵一发动全身。

---

## 6. 历史修复索引（FIX-a~h：已踩过的坑，改码前先查）

> 每轮一行摘要+锚点。**新改动若触及同区域，先 grep 该 FIX 注释确认现有语义，再决定是否扩展**。

| 批次 | 主题 | 关键内容与锚点（grep 可查） |
|---|---|---|
| FIX-2026-08-04（×31） | 对话隔离基础 | 双轨状态（items/fullMessages）、window 代理、`_origConvId` 捕获、消息序列校验、压缩标记 |
| FIX-2026-08-04-b（×22） | 多对话并发 | 切换搬移/快照恢复、流式目标锁定 `_streamTargetConvId`、工具路径 convId 显式化、心流 `_setFlowSession(sess,convId)`、task 通知收尾单发 |
| FIX-2026-08-04-c（×16） | 稳定性/审查 | 第 5 轮审查项（时间/worker 崩溃重启/技能补丁回滚等；grep `FIX-2026-08-04-c` 逐个确认） |
| FIX-2026-08-04-d（×18） | 性能与质量（第 6 轮） | VFS 快照前缀白名单 `listAllVfsPaths(prefix)`；搜索标题快速路径（输入零IO/回车全文）；列表 DocumentFragment+事件委托；beforeunload 快照 3MB 裁剪；tokenTimer `document.hidden` 守卫；sendToTaskWorker 默认超时 60s（原 100min 滞留） |
| FIX-2026-08-04-e | 流式渲染降级 | `_renderStreamContent`/`_looksLikeMarkdown`：流式中间态纯文本 O(1)，流结束全量渲染；宽松匹配宁全量勿漏 |
| FIX-2026-08-04-f | （第 8 轮） | 本手册未收录详情，grep `FIX-2026-08-04-f` 确认内容后再扩展 |
| FIX-2026-08-04-g | 渲染缓存 | `_mdHtmlCache`（key=katex状态前缀+原文，200条/8MB）/`_artSanCache`（50条/4MB）；DOMPurify 输出原样缓存；超限 clear() |
| FIX-2026-08-04-h | 杂项优化 ×3 | P5 thinking RAF 节流（`_flushThinkingBlock`）；U1 流式 aria-live off/恢复；N3 取消链路（`_withTimeout` onTimeout→AbortController→`abort_task` 协议→custom_api_call `AbortSignal.any`） |
| FIX-2026-08-04-i | 压缩断点续跑 | `_compressOldMessages` 增 `injectResume` 参数：自动压缩(400重试)路径注入 `[继续]` user 消息（`_injected:true`，`_tokens` 估算）重启断点任务；`_clean` 拷贝补保留 `_injected`（防[历史背景]/[继续]次轮压缩被当真实 user 污染轮次感知）；手动/预检压缩不注入 |

**核心教训**：全部修复围绕"异步代码在对话切换后的写目标错位"（铁律）与"重复计算/不可取消的资源滞留"（性能）。

---

## 7. 经验教训（总结性，适用后续所有轮次）

### 7.1 渲染性能三路径

| 路径 | 适用 | 实现 | 轮次 |
|---|---|---|---|
| 降级 | 流式中间态高频全量渲染 | `_renderStreamContent` 纯文本快速路径 | e |
| 缓存 | 稳定态同一内容重复渲染 | `_mdHtmlCache`/`_artSanCache`（key 含环境状态） | g |
| 节流 | 高频小更新（thinking chunk） | RAF 单槽位合并 + 完成时显式冲刷 | h |

三者互不替代：降级保流畅、缓存省重复、节流限频率。

### 7.2 性能优化与安全

- 缓存**净化结果**而非跳过净化；key 含环境状态防状态漂移（katex 加载前后）。
- 放宽防护在任何性能理由下都不接受；先查"重复计算"再查"计算本身"。

### 7.3 取消语义

- `Promise.race` 只放弃等待，不取消底层——取消必须**协作式**（AbortSignal/消息协议）。
- 已 abort 的 signal 检查必须置于**消息发送之前**（实测：检查后置会先发一条无效任务消息）。
- 串行 worker 中消息无法中断执行中任务；取消通道价值=协议完备+为并行化铺路，勿承诺即时中断。

### 7.4 修改与验证纪律

- 备份链：每轮改前 `copy → bak.vN`；完成后 diff 逐块核对（S3）。
- 行号漂移：插入/删除后整体偏移，每次定位重新 grep，禁止记忆行号。
- 单测提取三纪律：async 前缀 / 顶层 var 绑定 / mock 匹配一致性（见 4.3）。
- 评估先行：改前量化成本（改动量/风险/回归面）× 收益（频率/单次成本/可感知性）；收益<成本记录在案不实施（如 P4 列表增量、P3 倒排索引被否）。
- 压缩断点续跑（FIX-i）：压缩后上下文末尾是 `[历史背景]` 摘要(user)消息，模型无继续指令→输出收尾文本而非 tool_calls→processUserMessage 循环 break→重型任务中断；自动压缩(400重试)路径必须注入 `[继续]` 指令（`_injected:true`）重启断点，手动/预检压缩不注入。


---

## 附录 A：术语表

| 术语 | 含义 |
|---|---|
| convId | 对话唯一标识（`conv_时间戳`） |
| `_origConvId` | 发起对话（处理开始时捕获，防切换写错） |
| `_streamTargetConvId` | 流式写目标锁定 |
| items / fullMessages | 气泡列表（用户所见）/ API 上下文快照（token 级） |
| 双轨持久化 | items + fullMessages 同时落库 |
| 骨架 | fullMessages 恢复后的消息数组（压缩/编辑检测基准） |
| flow_role | root=主 Agent 可见；supervisor=仅监工可见 |
| per-path 锁 | 按文件路径的 promise 链写锁 |
| 降级/缓存/节流 | 渲染三路径（7.1） |
| abort_task | worker 任务取消消息协议 |

## 附录 B：交付检查清单（每次修改后逐项过）

- [ ] 备份 bak.vN 存在（改前）
- [ ] S1 语法验证 0 错误（主文件 + S4 worker 片段）
- [ ] S2 语义单测覆盖新增分支（三纪律）
- [ ] S3 diff 与备份核对：无意外删除/新增
- [ ] S5 铁律点频率比对（隔离回归）
- [ ] 修复注释 `★ [FIX-日期-x]` 病因+意图（无过程叙述）
- [ ] 本文档第 6/7 章已更新
- [ ] 记忆沉淀（longterm_memory + knowledge_base）
- [ ] 改动摘要报告（写文件）
