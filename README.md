# 本地播控主控台（Lease + Epoch Fencing）

一个纯浏览器本地运行的多席位播控主控台：每个浏览器标签页是一个独立席位
（导播主机 / 备机 / 现场大屏），席位间用真实的 **BroadcastChannel** 和
**storage 事件**同步，租约保存在 **localStorage**，竞争写入通过
**Web Locks** 串行化，并带有持续递增的 **epoch（fencing token）**。

旧主控休眠或网卡顿、备机接管之后，旧窗口恢复时再发的切台命令会被
**锁内复核**与 **epoch fencing** 双重拒绝；延迟、乱序、重复命令分别被
拒绝或幂等处理，同一动作绝不会执行两次。

## 运行

```bash
npm install
npm run dev      # 打开 http://localhost:5173，再复制 URL 多开几个标签页
npm test         # 17 个并发/恢复测试（vitest，假时钟 + 手动消息总线）
npm run build    # 类型检查 + 生产构建
```

## 界面能看到什么

- **席位表**：所有标签页席位、角色（主控/备机/离线）、在线心跳、各自已执行到的序列号；
- **主控租约**：当前主控、**epoch**、**剩余租约倒计时**（TTL 5s，每 1.5s 续约）；
- **播控操作**：切 1~4 号机 / 黑场 / 应急静帧（仅主控可点）；
- **交接控制**：正常交接（主控主动让位）与强制接管（备机立即夺权，epoch +1）；
- **故障注入（只影响本窗口）**：
  - ⏸ 模拟休眠/网卡顿：冻结本窗口计时器、挂起入站 BroadcastChannel 与 storage 事件；
  - 消息延迟滑杆（0–6000ms，可超过租约 TTL 验收在途命令拒绝）；
  - 每条消息重发一份（验收幂等去重）；
- **命令执行结果矩阵**：每条命令 × 每个席位一格——`已执行` / `重复·幂等` / `已拒绝`，
  悬停可看拒绝原因（旧 epoch、乱序、在途窗口过期等）。

刷新页面（F5）后席位 ID 不变（存于 sessionStorage），租约、epoch、命令日志、
每席位执行水位与结果都从 localStorage 恢复。

## 现场验收脚本（多标签页）

1. 开 3 个标签页，分别改名为「导播A」「备机B」「大屏C」；首个打开的自动当选 epoch 1。
2. **正常交接**：在 A 上选择「交接给 备机B」→ A 立刻变备机，B 以 epoch 2 上任。
3. **租约过期接管**：在 A 任主控时点「模拟休眠」，等 6 秒 → B 自动接管（epoch +1）；
   点「恢复运行」→ A 先收到 takeover/storage 通知退位；此时在 A 点切台
   （恢复后按钮已禁用，可直接看续约/锁内复核），命令以「主控已易主，旧窗口命令被拒绝」留痕。
4. **强制接管**：B 健康任主控时，在 C 点「强制接管」→ epoch +1，B 立即退位。
5. **重复消息**：勾选「每条消息重发一份」后切台 → 其他席位对同一命令 ID
   只执行一次，副本全部显示「重复·幂等」。
6. **消息延迟/乱序**：把延迟拉到 6000ms（超过 TTL）再切台 → 延迟到达的
   旧任期命令显示「已拒绝：命令来自旧任期」。
7. **刷新恢复**：主控 F5 → 仍是同一 epoch 的主控，序列号继续递增；
   备机 F5 期间主控发令 → 恢复后按共享命令日志连续补齐（结果带补缺标记）。

## 正确性设计

| 风险 | 机制 |
| --- | --- |
| 两个席位同时抢主控 | Web Locks 把读-改-写租约串行化，后进入者读到更高 epoch 后主动退位，epoch 严格 +1 |
| 旧主控醒来继续发令 | 签发命令前在锁内重读租约复核 (leaderId, epoch)；不符立即退位并拒绝 |
| 旧任期命令迟到/乱序 | 每条命令带 fencing token `(leaderId, epoch)`，执行端与当前租约比对，旧 epoch 一律拒绝 |
| 网络重复投递 | 命令带全局唯一 ID，接收端维护已执行集合，重复回放为 `duplicate`，不二次执行 |
| 乱序/跳号 | 主控端 seq 按任期从 1 递增，接收端只接受 `appliedSeq+1`；分区恢复造成的缺口从 localStorage 共享命令日志按序补齐，缺链才拒绝 |
| 通知通道丢失 | takeover 同时走 BroadcastChannel 与 localStorage(storage 事件)，主控续约时还会在锁内对账自退位 |
| 在途命令 | 命令带 `issuedAt`：到达时租约刚过期但签发在一个 TTL 窗口内仍执行；超窗拒绝 |
| 刷新 | 租约 + 共享状态（命令日志、各席位结果、水位）持久化于 localStorage，重启即恢复 |

## 代码结构

```
src/core/
  types.ts       可注入接口：Clock / Bus / KeyValueStore / LockManager / Scheduler
  protocol.ts    消息、租约、持久化状态结构与常量
  real.ts        真实浏览器适配器（Date、BroadcastChannel、localStorage、Web Locks）
  delay.ts       DelayedBus：注入消息延迟与重复
  pause.ts       PausableBus / PausableKV：模拟休眠时挂起消息与 storage 事件
  coordinator.ts 核心：租约续约/接管/交接、fencing、seq 补缺、幂等裁决
test/
  helpers/harness.ts  手动假时钟、消息 Hub、KV 集群、假 Web Locks
  coordinator.test.ts 同时抢占 / 旧主控恢复 / 重复消息 / 乱序补缺 / 刷新恢复等 17 例
```

核心的 `Coordinator` 不直接依赖任何浏览器 API——时钟、总线、存储、锁、
定时器全部构造时注入，因此并发场景可在测试中被确定性地复现。
