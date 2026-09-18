# 本地播控主控台

纯浏览器本地运行的多席位播控主控台。解决的问题：导播主机、备机、现场大屏的多个标签页
同时打开播控页面时，主控窗口休眠或网卡后备机接管；旧窗口恢复后若继续发切台命令，
同一动作会被执行两次。本项目用 **租约选举 + 持续递增 epoch（fencing token）+
命令 seq/幂等键** 保证任何旧 epoch、延迟、乱序或重复命令都被拒绝或幂等处理。

## 启动

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest，34 个测试
npm run build      # tsc 类型检查 + 生产构建
```

打开 3 个浏览器标签页（导播主机 / 备机 / 现场大屏），即可现场验收。全部状态在浏览器本地：
BroadcastChannel 传消息、localStorage 存租约与状态、storage 事件做跨标签页同步、
Web Locks 串行化竞争写入。没有服务端。

## 界面能看到什么

- **席位**：所有在线标签页、类型、当前角色（主控/备机）、最后可见时间；
- **当前主控**：持有者、租约 epoch、命令围栏 epoch、见过的最大 epoch、剩余租约进度条、
  下条 seq、接管方式、PGM 当前通道与录制状态；
- **播控操作**：切台 CH1–8、开始/停止录制、正常交接、强制接管；
- **命令执行结果**：每条命令在本席的 `已执行 / 重复忽略 / 已拒绝` 及原因；
- **选举/租约事件流**：成为主控、下台、拒绝、休眠等；
- **故障注入**：模拟休眠（挂起定时器 + 丢弃入站消息）、入站固定延迟、随机抖动制造乱序。

刷新页面会从 localStorage 恢复主控身份（租约未过期时）、业务状态、epoch 与已执行命令集合。

## 核心协议

### 租约（localStorage `pocc.lease.v1`，Web Lock 内 CAS 写入）

```
{ holderId, epoch, acquiredAt, expiresAt, reason }
```

- TTL 6s，主控每 2s 续约；租约到期备机在下个 tick（250ms）发起 `expiry` 接管。
- **每次 leadership 变化 epoch 严格 +1**（初始获取 / 过期接管 / 强制接管 / 正常交接）。
  epoch 只增不减，决策基数取 `max(storage 租约 epoch, 本席见过的最大 epoch)`。
- 所有对租约键的读-判定-写都在 `navigator.locks.request('pocc-lease-lock-v1')` 内完成；
  同时强制接管时，后进入锁的一方发现 epoch 已被抬升即放弃，**只有一个赢家、epoch 只跳一次**。
- 正常交接：主控把租约 `expiresAt` 写为当前时刻并广播 `release`，随后短暂回避竞选；
  备机收到后立即竞选，无需等满 TTL。
- 强制接管：不必等过期，但同样在锁内抬升 epoch；旧主控的续约在锁内发现持有者已变，
  立即下台，绝不反向覆盖。

### 命令（BroadcastChannel `command` + localStorage 状态对账）

```
{ id, from, type, input, epoch, seq, issuedAt }
```

三重围栏，按顺序校验：

1. **幂等键 `id`**：命中最近 200 条已应用 id ⇒ `duplicate`，动作不重复执行；
2. **新鲜度**：到达时距签发超过命令寿命（默认 2×TTL）⇒ 拒绝，挡休眠后回放；
3. **epoch 围栏**：命令 epoch 必须等于本席当前期望围栏——
   小于是旧主控残留/延迟回放，大于是来源未知/本席落后，全部拒绝；
   且发送者必须是该 epoch 的持有者、命令到达时该租约仍存活；
4. **seq**：同一 epoch 内必须严格连续（期望 lastSeq+1），跳号/重放拒绝；
5. 载荷校验（switch 通道 1..8）。

签发也在 Web Lock 内做最后一次租约复核（持有者、epoch、存活、围栏），
因此“强制接管的同一瞬间旧主控点下的切台”会在锁内被撤销，不会双发。

业务状态（PGM 通道、录制、已应用 id、日志）只由主控写 `pocc.state.v1`，
备机通过 storage 事件获得权威副本，并与命令广播两条路径做合并去重。

### 休眠模型

`core.sleep(ms)`：停止续约定时器、链路条件 `sleeping=true`，延迟管道丢弃期间所有
入站 BroadcastChannel / storage 消息（浏览器挂起标签页时 BroadcastChannel 本就不缓存）。
超过 TTL 后备机自然过期接管。唤醒后以 **storage 为唯一事实源**重新对齐：
发现持有者已不是自己就接受下台；此后它携带旧 epoch 的命令在任何席位都过不了围栏。

### 可注入性（`src/core/env.ts`、`src/core/pipe.ts`）

核心引擎 `PlayoutCore` 只依赖四个接口：`Clock`（含手动/墙钟）、`MessageBus`、
`KVStore`、`LockManagerLike`，以及一个共享的 `LinkConditions`（延迟/抖动/休眠）。
浏览器实现与测试内存实现可互换。

## 代码结构

```
src/core/
  types.ts        类型与线协议
  env.ts          Clock/MessageBus/KVStore/Lock 接口 + 浏览器实现
  pipe.ts         入站延迟 / 抖动乱序 / 休眠丢弃管道
  protocol.ts     纯函数：租约决策 decideClaim、命令校验 validateCommand、状态归并
  PlayoutCore.ts  选举 + 续约 + 签发 + 休眠恢复引擎
src/ui/           React 界面（席位表、主控面板、播控、故障注入、日志、事件流）
src/testing/world.ts  内存世界：手动时钟、共享 storage、广播总线、FIFO Web Lock
src/core/*.test.ts    纯协议单测 + 多席位集成场景
```

## 建议的现场验收脚本

1. 开 3 个标签页，分别改成“导播主机/备机/现场大屏”，观察只有一个主控、epoch 相同；
2. 主控点 CH3、录制：三个页面 PGM=3、REC 亮，命令结果都是“已执行”；
3. 主控设置 2s 入站延迟后连发 CH4→CH5：备机稍后收到，顺序与结果一致；
4. 主控“模拟休眠 8s”：约 6s 后备机过期接管（epoch+1）；唤醒旧主控，
   它显示待机；此时在旧窗口点切台——按钮不可用/被拒绝，PGM 不变；
5. 备机点“强制接管”：epoch 立刻 +1；再向系统注入重复/乱序消息可在日志看到
   “重复忽略 / 旧 epoch / seq 乱序”拒绝；
6. 主控点“正常交接”：备机 1 秒内以新 epoch 平稳接管；
7. 主控在租约内刷新：身份、PGM、epoch 与 seq 全部恢复，还能接着发命令（seq 连续）。
